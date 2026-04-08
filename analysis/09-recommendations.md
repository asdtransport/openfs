# OpenFS — Recommendations & Roadmap

## Production Readiness Gaps

### Critical (Must-Fix Before Production)

1. **Implement auth middleware** — The Hono server's `authMiddleware` and `rbacMiddleware` are stubs. Wire them to a real identity provider (OAuth2/OIDC) and enforce PathTree RBAC.

2. **Rotate all default credentials** — Remove hardcoded MediaWiki password, MinIO keys, JWT secret, and `demo-token` from source. Use a secrets manager or `.env` with proper gitignore.

3. **Add rate limiting** — LLM-calling endpoints (`/query`, `/query-agent`, `/ingest`) have no rate limits. A single client could exhaust API quotas.

4. **CORS configuration** — Lock down allowed origins for production deployment.

5. **Input validation on shell commands** — While `just-bash` is sandboxed, validate/sanitize command input to prevent unexpected behavior.

### Important (Should-Fix)

6. **Split `server.ts`** — The 2200-line sync server file needs refactoring into route modules (similar to how `packages/server` separates `fs.ts`, `admin.ts`, `s3-api.ts`).

7. **Error handling audit** — Replace silent `catch {}` blocks with proper logging. Add structured error types.

8. **Test coverage** — Add unit tests for core packages (PathTree, grep optimizer, adapters). Integration test infrastructure exists but needs population.

9. **Observability** — Add structured logging, request tracing, and metrics collection. The sync server has basic `console.log` — needs proper log levels.

10. **Database migrations** — No schema migration strategy. Adding columns to the `files` table or changing FTS5 config requires manual intervention.

## Feature Opportunities

### High Value

- **Tab completion** in the terminal — would dramatically improve UX for the target audience
- **Persistent WASM state** — save/restore sql.js DB to IndexedDB (the `export()` method exists but isn't wired to the UI)
- **Webhook triggers** — notify external systems when wiki pages are created/updated
- **Multi-tenant isolation** — PathTree RBAC exists but needs per-tenant adapter instances
- **Streaming responses** — long LLM answers should stream to the terminal progressively

### Medium Value

- **Syntax highlighting** in `cat` output (language detection + ANSI coloring)
- **Pagination** for large outputs (`cat --page`, `grep --page`)
- **File diffing** — show what the LLM changed when synthesizing wiki pages
- **Undo/rollback** — version history for wiki pages (SQLite has the `mtime` column)
- **Search relevance scoring** — expose FTS5 rank scores and Chroma distances to the user

### Exploratory

- **MCP (Model Context Protocol) server** — expose OpenFS as an MCP tool server for Claude Desktop and other AI clients
- **Plugin system** — allow custom adapters to be loaded at runtime
- **Real-time collaboration** — WebSocket-based multi-user terminal sessions
- **Mobile app** — the Telegram bot already provides mobile access, but a native app could offer richer UX

## Architecture Improvements

1. **Event-driven sync** — Replace 60-second polling with MediaWiki webhooks or EventStreams
2. **Queue-based ingestion** — Large S3 pipelines should use a job queue (BullMQ/Redis) instead of synchronous processing
3. **Adapter registry** — Replace string-based adapter selection (`"sqlite"`, `"chroma"`, `"s3"`) with a typed registry
4. **Shared types package** — Extract common types into `@openfs/types` to avoid cross-package source imports
5. **Configuration validation** — Use Zod schemas to validate environment variables at startup

## Documentation Improvements

- Add API reference docs (OpenAPI/Swagger for the Hono server and FastAPI)
- Create a "Getting Started" tutorial separate from the README
- Document the LLM prompt templates and how to customize them
- Add architecture decision records (ADRs) for key design choices
