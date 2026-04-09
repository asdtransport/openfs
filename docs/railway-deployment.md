# OpenFS — Railway Deployment Guide

Everything runs in **one container** — Bun API, Python S3 API, ChromaDB, MinIO, and the static playground. Just deploy and go.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Railway Service: openfs (single container)                 │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ MinIO         │  │ ChromaDB     │  │ Bun API (Hono)   │  │
│  │ S3 storage    │  │ vector store │  │ :$PORT (public)   │  │
│  │ :9000         │  │ :8000        │  │  /api/fs/*        │  │
│  └──────────────┘  └──────────────┘  │  /api/s3/* → 8080 │  │
│                                       │  /sync/*  → 4322  │  │
│  ┌──────────────┐  ┌──────────────┐  │  /*  playground    │  │
│  │ Python API    │  │ Wiki sync    │  └──────────────────┘  │
│  │ adapter-s3    │  │ (optional)   │                        │
│  │ :8080         │  │ :4322        │  ┌──────────────────┐  │
│  └──────────────┘  └──────────────┘  │ /data volume      │  │
│                                       │  minio/ chroma/   │  │
│                                       │  openfs.db        │  │
│                                       └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

All services are internal except the Hono server, which is the single public port.

---

## Files

| File | Purpose |
|------|---------|
| `Dockerfile.railway` | 4-stage build: playground → bun deps → python venv → runtime |
| `start-railway.sh` | Boots MinIO → ChromaDB → S3 API → wiki sync → Hono |
| `railway.toml` | Build config, volume mount at `/data` |

---

## Quick Start

```bash
# 1. Install Railway CLI
brew install railway        # macOS
# npm i -g @railway/cli     # or npm

# 2. Login
railway login

# 3. Create project
cd /path/to/openfs
railway init --name openfs

# 4. Deploy
railway up --detach

# 5. Get your public URL
railway domain
```

That's it. The container starts MinIO, ChromaDB, the Python API, and the Hono server automatically. The default bucket is created on first boot.

---

## Environment Variables

Everything has sensible defaults. You only **need** to set these if you want to customize:

### Optional Overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Public port (Railway sets this) |
| `MINIO_ROOT_USER` | `minioadmin` | MinIO admin username |
| `MINIO_ROOT_PASSWORD` | `minioadmin` | MinIO admin password — **change in prod** |
| `S3_BUCKET` | `openfs-playground` | Default bucket name |
| `OPENFS_DB` | `/data/openfs.db` | SQLite database path |

### For MediaWiki Sync (optional)

| Variable | Description |
|----------|-------------|
| `MW_URL` | MediaWiki API URL (enables sync server) |
| `MW_USER` | MediaWiki bot username |
| `MW_PASS` | MediaWiki bot password |
| `ANTHROPIC_API_KEY` | For LLM wiki synthesis |
| `OPENAI_API_KEY` | For embeddings |

### Auto-configured (don't change)

These are wired internally by `start-railway.sh`:

| Variable | Value | Description |
|----------|-------|-------------|
| `S3_ENDPOINT` | `http://localhost:9000` | MinIO (same container) |
| `CHROMA_URL` | `http://localhost:8000` | ChromaDB (same container) |
| `MINIO_API_URL` | `http://localhost:8081` | Python S3 API (same container) |
| `STATIC_DIR` | `/app/playground-dist` | Built Astro files |

---

## Routing (Single Public Port)

| Path | Destination |
|------|-------------|
| `/api/fs/*` | Hono (direct) — filesystem ops |
| `/api/admin/*` | Hono (direct) — admin ops |
| `/api/s3/*` | Proxy → Python S3 API `:8080` |
| `/sync/*` | Proxy → wiki sync server `:4322` |
| `/health` | Hono (direct) — health check |
| `/*` | Static playground files |

---

## Subsequent Deploys

```bash
git add -A && git commit -m "your message"
railway up --detach
```

---

## Persistent Data

The `/data` volume (configured in `railway.toml`) stores:
- `/data/minio/` — S3 object storage
- `/data/chroma/` — Vector embeddings
- `/data/openfs.db` — SQLite filesystem database

Data persists across deploys and restarts.

---

## Startup Sequence

`start-railway.sh` boots services in order:

1. **MinIO** → waits for health check → creates default bucket
2. **ChromaDB** → waits for heartbeat
3. **Python adapter-s3-api** → waits for `/health`
4. **agent-wiki-mw** → only if `MW_URL` is set
5. **Hono server** → foreground process (`exec`, becomes PID 1)

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Build fails at playground | Run `pnpm install` locally to update lockfile |
| SQLite "unable to open" | Verify `/data` volume is mounted |
| Playground blank page | Check `STATIC_DIR=/app/playground-dist` |
| S3 API 503 | Check MinIO logs — may need more RAM |
| ChromaDB timeout | ChromaDB needs ~256MB RAM on first boot |

---

## Resource Estimate

| Component | RAM |
|-----------|-----|
| MinIO | ~128MB |
| ChromaDB | ~256MB |
| Python S3 API | ~64MB |
| Bun (Hono + server) | ~128MB |
| SQLite | ~32MB |
| **Total** | **~608MB** |

Fits comfortably in Railway's Hobby plan (8GB limit).

---

## Useful Commands

```bash
railway status          # Check link status
railway logs            # View deploy logs
railway variables       # List env vars
railway domain          # Generate public URL
railway up --detach     # Deploy
railway down            # Remove latest deploy
railway open            # Open dashboard
```

---

## Adding MediaWiki (Optional)

If you want the wiki sync feature, deploy MediaWiki as a separate Railway service:

1. **Source**: Dockerfile in `packages/mediawiki`
2. **Port**: `80`
3. **Volume**: `/var/www/data`

Then set `MW_URL`, `MW_USER`, `MW_PASS` on the main service to enable the sync server.
