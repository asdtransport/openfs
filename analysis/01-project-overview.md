# OpenFS — Project Overview

## What Is It

OpenFS is a **pluggable virtual filesystem for AI agents** that maps standard UNIX shell commands (`ls`, `cat`, `grep`, `find`, `stat`, `head`, `tail`, `wc`) to various backing data stores. Instead of giving AI agents real filesystem access (expensive sandboxes, security risks), OpenFS provides a familiar shell interface over databases.

## Core Value Proposition

- **No sandbox required** — AI agents get filesystem semantics without containers or VMs
- **Sub-millisecond reads** — database-backed storage is faster than disk I/O
- **Multi-backend** — same interface works over SQLite, ChromaDB (vectors), and S3/MinIO
- **Grep optimization** — two-phase search: native DB search → fine regex filter
- **RBAC built-in** — path-level access control via user groups

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun (server), sql.js WASM (browser) |
| Language | TypeScript (main), Python (S3 API) |
| Shell emulation | `just-bash` library |
| Databases | SQLite (FTS5), ChromaDB, S3/MinIO |
| API server | Hono (TypeScript) |
| S3 management API | FastAPI (Python) |
| Playground UI | Astro + xterm.js |
| LLM providers | Anthropic Claude, OpenAI GPT-4o |
| Messaging | Telegram (grammY) |
| Containerization | Docker Compose (9 services) |
| Package manager | pnpm workspaces (monorepo) |
| License | Apache-2.0 |

## Monorepo Structure (12 packages)

```
packages/
├── core/                 # OpenFsAdapter interface, PathTree, createOpenFs
├── adapter-sqlite/       # bun:sqlite + FTS5 adapter
├── adapter-chroma/       # ChromaDB vector adapter
├── adapter-s3/           # AWS SDK S3/MinIO adapter
├── adapter-s3-api/       # Python FastAPI — full S3 management API
├── grep-optimizer/       # Two-phase grep: coarse→prefetch→fine
├── wasm/                 # sql.js WASM adapter + AgentFs facade
├── server/               # Hono REST API server
├── playground/           # Astro interactive terminal UI
├── agent-wiki/           # LLM-powered knowledge base engine
├── agent-wiki-mw/        # MediaWiki ↔ OpenFS sync server
├── agent-knowledge/      # S3→Chroma→KG→Wiki ingest pipeline
└── bot-telegram/         # Telegram bot interface
```

## Deployment Architecture

Docker Compose orchestrates 9 services: ChromaDB, MinIO, bucket-init, adapter-s3-api (FastAPI), openfs-server (Hono), playground (Astro), mediawiki-sync (agent-wiki-mw), MediaWiki instance, and optionally a Telegram bot.
