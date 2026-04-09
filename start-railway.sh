#!/bin/bash
# ============================================================
# OpenFS — Railway entrypoint (all-in-one container)
#
# Starts all services:
#   1. MinIO S3 storage on :9000
#   2. ChromaDB vector store on :8000
#   3. Python adapter-s3-api (FastAPI) on :8080
#   4. Bun agent-wiki-mw (sync server) on :4322  (if MW_URL set)
#   5. Bun openfs-server (Hono API + playground) on :$PORT
#
# The Hono server is the foreground process (public port).
# ============================================================

set -e

# ── Environment defaults ─────────────────────────────────────
export PORT="${PORT:-3456}"
export NODE_ENV="${NODE_ENV:-production}"
export STATIC_DIR="${STATIC_DIR:-/app/playground-dist}"
export OPENFS_DB="${OPENFS_DB:-/data/openfs.db}"
export OPENFS_DB_PATH="${OPENFS_DB_PATH:-/data/openfs.db}"

# MinIO
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
export S3_ENDPOINT="${S3_ENDPOINT:-http://localhost:9000}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-$MINIO_ROOT_USER}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-$MINIO_ROOT_PASSWORD}"
export S3_BUCKET="${S3_BUCKET:-openfs-playground}"

# Adapter-S3-API (Python FastAPI) — port 8081 to avoid clash with Railway PORT
export MINIO_API_URL="${MINIO_API_URL:-http://localhost:8081}"
export MINIO_ENDPOINT="${MINIO_ENDPOINT:-localhost:9000}"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-$MINIO_ROOT_USER}"
export MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-$MINIO_ROOT_PASSWORD}"
export MINIO_SECURE="${MINIO_SECURE:-False}"

# ChromaDB
export CHROMA_URL="${CHROMA_URL:-http://localhost:8000}"

# ── 1. Start MinIO ──────────────────────────────────────────
echo "▶ Starting MinIO on :9000..."
minio server /data/minio --address ":9000" --console-address ":9001" &
MINIO_PID=$!

# Wait for MinIO to be ready
echo "  Waiting for MinIO..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:9000/minio/health/live > /dev/null 2>&1; then
    echo "  ✓ MinIO ready"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "  ⚠ MinIO did not respond in 30s — continuing anyway"
  fi
  sleep 1
done

# Create default bucket
echo "  Creating bucket: $S3_BUCKET..."
mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" 2>/dev/null || true
mc mb "local/$S3_BUCKET" --ignore-existing 2>/dev/null || true
echo "  ✓ Bucket ready"

# ── 2. Start ChromaDB ───────────────────────────────────────
export ANONYMIZED_TELEMETRY=false

# Patch chromadb to handle missing _type in collection configuration
# (JS client chromadb@3.x sends getOrCreateCollection without _type field)
# Replaces ALL occurrences of json_map['_type'] — including the one inside
# the error message f-string on line 209 which also throws KeyError.
echo "▶ Patching ChromaDB configuration..."
python3 -c "
import chromadb.api.configuration as cfg
import inspect

src_file = inspect.getfile(cfg)
with open(src_file, 'r') as f:
    src = f.read()

TARGET = \"json_map['_type']\"
REPLACEMENT = \"json_map.get('_type', cls.__name__)\"

if TARGET in src:
    patched = src.replace(TARGET, REPLACEMENT)
    with open(src_file, 'w') as f:
        f.write(patched)
    count = src.count(TARGET)
    print(f'  ✓ Patched configuration.py — replaced {count} occurrence(s) of _type')
else:
    print('  ✓ configuration.py already patched')
" 2>&1 || echo "  ⚠ Could not patch chromadb"

# Pre-create collections via PersistentClient
echo "▶ Pre-creating ChromaDB collections..."
python3 -c "
import chromadb
client = chromadb.PersistentClient(path='/data/chroma')
client.get_or_create_collection('openfs-knowledge')
client.get_or_create_collection('openfs-docs')
print('  ✓ ChromaDB collections pre-created')
" 2>&1 || echo "  ⚠ Could not pre-create collections"

echo "▶ Starting ChromaDB on :8000..."
python3 -m chromadb.cli.cli run \
  --host 0.0.0.0 \
  --port 8000 \
  --path /data/chroma &
CHROMA_PID=$!

# Wait for ChromaDB
echo "  Waiting for ChromaDB..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/api/v1/heartbeat > /dev/null 2>&1; then
    echo "  ✓ ChromaDB ready"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "  ⚠ ChromaDB did not respond in 30s — continuing anyway"
  fi
  sleep 1
done

# ── 3. Start Python adapter-s3-api ──────────────────────────
echo "▶ Starting adapter-s3-api (FastAPI) on :8081..."
cd /app/packages/adapter-s3-api
python3 -m uvicorn app.main:app \
  --host 0.0.0.0 \
  --port 8081 \
  --log-level info &
S3_API_PID=$!

# Wait for S3 API
echo "  Waiting for adapter-s3-api..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:8081/health > /dev/null 2>&1; then
    echo "  ✓ adapter-s3-api ready"
    break
  fi
  if [ $i -eq 20 ]; then
    echo "  ⚠ adapter-s3-api did not respond in 20s — continuing anyway"
  fi
  sleep 1
done

# ── 4. Start MediaWiki (PHP built-in server) ─────────────────
export MW_URL="${MW_URL:-http://localhost:8082}"
# MW_SERVER = public-facing URL for browser links; MW_SCRIPT_PATH = proxy prefix
if [ -n "$RAILWAY_PUBLIC_DOMAIN" ]; then
  export MW_SERVER="${MW_SERVER:-https://$RAILWAY_PUBLIC_DOMAIN}"
  export MW_SCRIPT_PATH="${MW_SCRIPT_PATH:-/mw}"
else
  export MW_SERVER="${MW_SERVER:-http://localhost:8082}"
  export MW_SCRIPT_PATH="${MW_SCRIPT_PATH:-}"
fi

# Point MediaWiki SQLite data to persistent volume
export MW_SQLITE_DATA_DIR="/data/mediawiki"

# Update LocalSettings.php SQLite path at runtime
sed -i "s|/var/www/data|/data/mediawiki|g" /app/packages/mediawiki/LocalSettings.php 2>/dev/null || true

# Initialize MediaWiki SQLite database on first run
if [ ! -f /data/mediawiki/my_wiki.sqlite ]; then
  echo "  Initializing MediaWiki database (first run)..."
  cp /app/packages/mediawiki/LocalSettings.php /tmp/LocalSettings.php.bak
  rm -f /app/packages/mediawiki/LocalSettings.php
  php /app/packages/mediawiki/maintenance/install.php \
    --dbtype sqlite \
    --dbpath /data/mediawiki \
    --pass "${MW_PASS:-admin12345}" \
    --scriptpath "${MW_SCRIPT_PATH:-}" \
    --server "${MW_SERVER:-http://localhost:8082}" \
    "Derek Davis" \
    "${MW_USER:-Admin}" 2>&1 || echo "  ⚠ install.php returned non-zero (may be ok)"
  cp /tmp/LocalSettings.php.bak /app/packages/mediawiki/LocalSettings.php
  echo "  ✓ MediaWiki database initialized"
else
  echo "  ✓ MediaWiki database already exists"
fi

echo "▶ Starting MediaWiki on :8082..."
php -S 0.0.0.0:8082 -t /app/packages/mediawiki /app/mediawiki-router.php &
MW_PID=$!

# Wait for MediaWiki
echo "  Waiting for MediaWiki..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:8082/api.php?action=query&meta=siteinfo&format=json > /dev/null 2>&1; then
    echo "  ✓ MediaWiki ready"
    break
  fi
  if [ $i -eq 20 ]; then
    echo "  ⚠ MediaWiki did not respond in 20s — continuing anyway"
  fi
  sleep 1
done

# ── 5. Start agent-wiki-mw sync server ───────────────────────
echo "▶ Starting agent-wiki-mw (sync server) on :4322..."
cd /app
bun run packages/agent-wiki-mw/src/server.ts &
WIKI_MW_PID=$!
sleep 3
echo "  ✓ agent-wiki-mw started (pid $WIKI_MW_PID)"

# ── 6. Start Hono API server (foreground) ────────────────────
echo "▶ Starting openfs-server (Hono) on :$PORT..."
echo "  Services: MinIO(:9000) ChromaDB(:8000) S3-API(:8081) MediaWiki(:8082) Hono(:$PORT)"
cd /app
exec bun run packages/server/src/index.ts
