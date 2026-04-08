# @openfs/adapter-s3-api

S3/MinIO management API for OpenFS — a full FastAPI service providing REST endpoints for bucket management, object operations, streaming uploads, IAM, search, analytics, and more.

## Architecture

This is a **Python (FastAPI)** service that runs alongside the main OpenFS Bun/Hono server. It connects directly to MinIO (or any S3-compatible store) and exposes a rich management API.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────┐
│  OpenFS Server   │────▶│  adapter-s3-api  │────▶│  MinIO  │
│  (Bun/Hono:3456) │     │  (FastAPI:8080)  │     │ (:9000) │
└─────────────────┘     └──────────────────┘     └─────────┘
        │                        │
        ▼                        ▼
  Playground UI            Swagger Docs
  (Astro:4321)           (/docs on :8080)
```

## API Endpoints

All endpoints are under `/api/v1`:

| Module | Prefix | Description |
|--------|--------|-------------|
| **buckets** | `/buckets` | Create, list, delete buckets |
| **files** | `/files` | Upload, download, delete files with presigned URLs |
| **objects** | `/objects` | Low-level object CRUD |
| **streaming** | `/stream` | Chunked streaming uploads with session management |
| **sync** | `/sync` | Rsync-like synchronization |
| **monitoring** | `/monitoring` | Health checks, metrics, cluster status |
| **dashboard** | `/dashboard` | Storage analytics dashboard data |
| **iam** | `/iam` | Users, groups, roles, policies |
| **search** | `/search` | Full-text search indexing |
| **analytics** | `/analytics` | Usage analytics and reports |
| **notifications** | `/notifications` | Event notifications and webhooks |
| **replication** | `/replication` | Cross-region replication |
| **lifecycle** | `/lifecycle` | Object lifecycle policies |
| **security** | `/security` | Encryption, audit, compliance |

## Running

### Via Docker Compose (recommended)

```bash
# From the openfs root
docker compose up -d
# API available at http://localhost:8080
# Swagger docs at http://localhost:8080/docs
```

### Locally

```bash
cd packages/adapter-s3-api
uv pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MINIO_ENDPOINT` | `minio:9000` | MinIO server endpoint |
| `MINIO_ACCESS_KEY` | `minioadmin` | Access key |
| `MINIO_SECRET_KEY` | `minioadmin` | Secret key |
| `MINIO_SECURE` | `False` | Use HTTPS |
| `MINIO_REGION` | `us-east-1` | S3 region |
| `API_PREFIX` | `/api/v1` | API route prefix |
| `LOG_LEVEL` | `INFO` | Logging level |

## Package Manager

Uses **[uv](https://github.com/astral-sh/uv)** for fast Python dependency management.
