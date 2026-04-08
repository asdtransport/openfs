# OpenFS

**A pluggable virtual filesystem for AI agents — backed by SQLite, Chroma, and S3/MinIO.**

Map UNIX commands (`cat`, `ls`, `grep`, `find`) to any backing store. Give your agent a real filesystem interface over your database — no sandbox, no container spin-up, millisecond responses.

Inspired by [Mintlify's ChromaFs](https://www.mintlify.com/blog/how-we-built-a-virtual-filesystem-for-our-assistant). Built to go further.

---

## Why agents need this

Real sandboxes are slow (~46s boot) and expensive (~$70k/yr at scale). OpenFS gives agents the *illusion* of a filesystem by routing every `IFileSystem` call to your database.

```
Agent runs: grep -ri "access_token" /docs/
                    ↓
            just-bash parses the command
                    ↓
         OpenFS intercepts the IFileSystem call
                    ↓
    SQLite FTS5 coarse filter  →  candidate files
                    ↓
      In-memory regex fine filter
                    ↓
         Results in milliseconds
```

No sandbox. No Docker. Just a database query that looks like a shell command.

---

## What's in this repo

```
openfs/
├── packages/
│   ├── core/               @openfs/core       — IFileSystem adapter interface + PathTree
│   ├── adapter-sqlite/     @openfs/adapter-sqlite  — SQLite FTS5 adapter
│   ├── adapter-chroma/     @openfs/adapter-chroma  — Chroma vector DB adapter
│   ├── adapter-s3/         @openfs/adapter-s3      — S3/MinIO adapter (AWS SDK)
│   ├── adapter-s3-api/     @openfs/adapter-s3-api  — FastAPI S3 management REST API
│   ├── grep-optimizer/     @openfs/grep-optimizer  — Coarse→prefetch→fine grep pipeline
│   ├── server/             @openfs/server          — Hono API server (agent endpoint)
│   └── playground/         @openfs/playground      — Astro interactive terminal UI
└── docker-compose.yml      — Full stack: MinIO + Chroma + FastAPI + Hono + Astro
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser / AI Agent                                                  │
│  http://localhost:4321 (playground)  or  direct API calls           │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ HTTP
┌───────────────────────────▼─────────────────────────────────────────┐
│  @openfs/server  (Hono, port 3456)                                   │
│                                                                      │
│  POST /api/fs/exec   { command, adapter }  ←  any shell command     │
│  GET  /api/fs/read   ?path=                ←  direct file read      │
│  GET  /api/fs/readdir ?path=&adapter=      ←  directory listing     │
│  POST /api/fs/search { query }             ←  full-text search      │
│  GET  /api/admin/stats                     ←  index stats           │
│  POST /api/admin/ingest { files }          ←  ingest new docs       │
│  /api/s3/*           → proxy →  adapter-s3-api                      │
└──────────┬───────────────────────────────────┬──────────────────────┘
           │                                   │
    ┌──────▼──────┐  ┌──────────┐   ┌─────────▼──────────────────────┐
    │   SQLite    │  │  Chroma  │   │  @openfs/adapter-s3-api        │
    │   FTS5      │  │ $contains│   │  FastAPI  (port 8080)           │
    │  :memory:   │  │  :8000   │   │  /api/v1/buckets  /objects     │
    └─────────────┘  └──────────┘   │  /iam  /monitoring  /stream    │
                                    └──────────────┬─────────────────┘
                                                   │
                                          ┌────────▼────────┐
                                          │  MinIO  (:9000) │
                                          │  S3-compatible  │
                                          │  object storage │
                                          └─────────────────┘
```

---

## Quick start (library)

```bash
bun add @openfs/core @openfs/adapter-sqlite just-bash
```

```typescript
import { Bash } from "just-bash";
import { createOpenFs } from "@openfs/core";
import { SqliteAdapter } from "@openfs/adapter-sqlite";

const adapter = new SqliteAdapter({ dbPath: "./docs.db" });
await adapter.ingestDirectory({
  "/docs/auth.md": "# Auth\nUse Bearer tokens...",
  "/docs/api.md":  "# API\nPOST /users requires access_token",
});
await adapter.init();

const bash = new Bash({ fs: createOpenFs(adapter), cwd: "/" });

const { stdout } = await bash.exec('grep -ri "access_token" /docs');
console.log(stdout);
// → /docs/api.md:POST /users requires access_token
```

---

## Quick start (full stack)

```bash
docker compose up --build
```

| Service | URL | Purpose |
|---------|-----|---------|
| Playground UI | http://localhost:4321 | Interactive terminal |
| Hono API | http://localhost:3456 | Agent endpoint |
| S3 API (Swagger) | http://localhost:8080/docs | Full S3 management |
| MinIO Console | http://localhost:9001 | Object storage UI |

Login: `minioadmin` / `minioadmin`

---

## Agent API

Everything your agent needs over HTTP at `http://localhost:3456`:

### Filesystem commands (all adapters)

```bash
# Run any shell command — ls, cat, grep, head, stat, find
POST /api/fs/exec
{ "command": "grep -r access_token /docs", "adapter": "sqlite" }
# adapter: "sqlite" | "chroma" | "s3"

# Response
{ "stdout": "...", "stderr": "", "exitCode": 0, "adapter": "sqlite", "optimized": true }
# optimized: true means grep ran through the coarse→prefetch pipeline
```

```bash
# Read a file directly
GET /api/fs/read?path=/docs/auth/oauth.mdx

# List a directory (structured JSON)
GET /api/fs/readdir?path=/docs&adapter=s3

# Check path exists
GET /api/fs/exists?path=/docs/auth/oauth.mdx&adapter=chroma

# Full-text search
POST /api/fs/search
{ "query": "how do I authenticate" }
```

### Admin

```bash
# Ingest new files into SQLite
POST /api/admin/ingest
{ "files": { "/docs/new.md": "# New\nContent..." } }

# Adapter stats
GET /api/admin/stats
```

### S3 management (proxied from Hono → FastAPI)

```bash
GET  /api/s3/buckets                              # list buckets
POST /api/s3/buckets  { "name": "my-bucket" }    # create bucket
GET  /api/s3/objects/objects/list/{bucket}?recursive=true&prefix=docs/
POST /api/s3/objects/objects/put/{bucket}         # write text object
     { "key": "notes/todo.md", "content": "..." }
GET  /api/s3/objects/objects/download/{bucket}?object_name=docs/auth/oauth.mdx
GET  /api/s3/monitoring/health                    # MinIO health
GET  /api/s3/monitoring/metrics                   # cluster metrics
GET  /api/s3/iam/users                            # IAM user list
```

Full Swagger UI at **http://localhost:8080/docs** — 80+ endpoints covering buckets, objects, streaming uploads, IAM, search indexing, analytics, notifications, replication, lifecycle, and security.

---

## Playground CLI

The playground at **http://localhost:4321** is a full terminal. Every command below works:

```
── Filesystem (active adapter) ─────────────────────────────
  ls [path]                   List directory
  cat <file>                  Read file
  head -n N <file>            First N lines
  grep <pattern> [path]       Search (coarse→fine optimizer)
  stat <file>                 Metadata
  find [path]                 Find files

── Search ───────────────────────────────────────────────────
  search <query>              Full-text search
  readdir <path>              Directory as JSON

── SQLite ───────────────────────────────────────────────────
  sqlite                      Switch to SQLite FTS5
  sqlite stats                File count & DB size
  sqlite search <query>       FTS5 search
  sqlite ingest <path> <txt>  Add file to index

── Chroma ───────────────────────────────────────────────────
  chroma                      Switch to Chroma vector DB
  chroma search <query>       Semantic $contains search
  chroma ls / cat             Run fs commands via Chroma

── S3 ───────────────────────────────────────────────────────
  s3                          Switch to S3/MinIO adapter
  s3 buckets                  List buckets
  s3 mk / rm <bucket>         Create / delete bucket
  s3 ls <bucket>[/<prefix>]   List objects (path filter)
  s3 cat <bucket>/<key>       Read object content
  s3 put <bucket> <key> <txt> Write text object
  s3 rm-obj <bucket> <key>    Delete object
  s3 health / metrics         Monitoring
  s3 iam [add <user> <pass>]  IAM management
  s3 help                     Full S3 reference

── Admin ────────────────────────────────────────────────────
  stats                       Index stats
  ingest <path> <content>     Ingest file into SQLite
```

---

## Adapters

| Package | Status | Backend | Search strategy |
|---------|--------|---------|----------------|
| `@openfs/adapter-sqlite` | ✅ v0.1 | SQLite (better-sqlite3) | FTS5 coarse + regex fine |
| `@openfs/adapter-chroma` | ✅ v0.1 | Chroma vector DB | `$contains` / `$regex` |
| `@openfs/adapter-s3` | ✅ v0.1 | S3 / MinIO (AWS SDK) | In-memory content cache |
| `@openfs/adapter-mysql` | 🚧 Stub | MySQL | FULLTEXT |
| `@openfs/adapter-postgres` | 🚧 Stub | PostgreSQL | tsvector / trigram |
| `@openfs/adapter-turso` | 🚧 Stub | Turso / libSQL | FTS5 (edge) |

---

## Grep optimizer

The `@openfs/grep-optimizer` package accelerates grep across large corpora:

```
grep -r "access_token" /docs
         ↓
1. Coarse search   — adapter.search("access_token") → candidate paths
2. Prefetch        — adapter.bulkPrefetch(candidates) → content cache
3. Fine filter     — standard regex grep on cached content only
```

The response includes `"optimized": true` when the pipeline ran, so your agent knows fewer files were scanned.

---

## How agents use this

An agent only needs three tool definitions:

```json
[
  {
    "name": "fs_exec",
    "description": "Run a shell command (ls, cat, head, grep, stat) against the OpenFS virtual filesystem. adapter: sqlite (FTS5), chroma (semantic), s3 (object storage).",
    "parameters": { "command": "string", "adapter": "sqlite|chroma|s3" }
  },
  {
    "name": "fs_search",
    "description": "Full-text search across all indexed files. Returns matching paths.",
    "parameters": { "query": "string" }
  },
  {
    "name": "s3_put",
    "description": "Write a text object to S3/MinIO storage.",
    "parameters": { "bucket": "string", "key": "string", "content": "string" }
  }
]
```

The agent calls `fs_exec` with any shell command — OpenFS handles routing to the right adapter, runs the grep optimizer if needed, and returns `stdout / stderr / exitCode` just like a real shell.

---

## Contributing

Every adapter is one file implementing `OpenFsAdapter`. See [CONTRIBUTING.md](./CONTRIBUTING.md).

1. **New adapters** — implement `readFile`, `search`, `bulkPrefetch`, `ingestDocuments`
2. **Grep strategies** — optimize the coarse search for your backend
3. **Indexer loaders** — ingest Markdown, OpenAPI specs, Git repos, PDFs

## Community

Built by the community, for the community. Claude is our community lead.

## License

Apache-2.0
