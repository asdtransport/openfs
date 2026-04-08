# OpenFS — Architecture & Coding Patterns

## 1. Adapter Pattern (Strategy)

The entire system is built around `OpenFsAdapter` — an interface that all storage backends implement. This is a textbook **Strategy pattern**: the core doesn't know or care which database it's talking to.

```
OpenFsAdapter (interface)
├── SqliteAdapter        (bun:sqlite, FTS5)
├── ChromaAdapter        (chromadb, $contains)
├── S3Adapter            (AWS SDK, MinIO)
└── SqliteWasmAdapter    (sql.js, browser-portable)
```

**Key methods**: `init()`, `readFile()`, `search()`, `bulkPrefetch()`, `writeFile?()`, `deleteFile?()`, `close()`

Write operations are **optional** (`writeFile?`, `deleteFile?`), making read-only adapters a first-class concept. This is a smart design — many data sources shouldn't be writable.

## 2. Facade Pattern (createOpenFs + AgentFs)

Two facade layers hide complexity:

- **`createOpenFs(adapter)`** — wraps any adapter into a `just-bash`-compatible `IFileSystem` with POSIX error semantics (`ENOENT`, `EISDIR`, `EROFS`)
- **`createAgentFs(docs)`** — one-call factory that boots WASM SQLite, ingests docs, builds path tree, creates Bash instance, and returns a clean `AgentFs` interface

End users never touch adapters, path trees, or Bash instances directly.

## 3. Pipeline Pattern (Grep Optimizer)

The grep optimizer implements a **three-stage pipeline**:

1. **Parse** — `parseGrepFlags()` extracts pattern, flags, paths from raw args
2. **Coarse filter** — `adapter.search()` uses native DB search (FTS5 / $contains / in-memory scan)
3. **Prefetch** — `adapter.bulkPrefetch()` loads candidate files into cache
4. **Fine filter** — `just-bash` runs the real `grep` regex over prefetched files

This turns O(n) full-corpus grep into O(k) where k << n.

## 4. In-Memory Tree (PathTree)

An in-memory directory tree built from the adapter's file index at init time. Supports:

- Path normalization
- RBAC pruning (filters paths by user groups at build time)
- O(1) existence checks, file/directory type checks
- Directory listing without hitting the database

## 5. Monorepo with Clean Boundaries

Each package has a single responsibility and explicit exports. Cross-package imports use `@openfs/` aliases defined in `tsconfig.json` path mappings. No circular dependencies observed.

## 6. Environment-First Configuration

All configuration uses environment variables with sensible defaults:

```typescript
const DB_PATH = process.env.OPENFS_DB ?? ":memory:";
const CHROMA_URL = process.env.CHROMA_URL ?? "http://localhost:8000";
```

No config files or complex setup — Docker Compose passes env vars.

## 7. Coding Practices Observed

| Practice | Assessment |
|----------|-----------|
| **TypeScript strict mode** | ✅ Enabled (`strict: true`) |
| **Interface-driven design** | ✅ Core interfaces define contracts |
| **Error handling** | ⚠️ Mix of try/catch and silent `catch {}` swallows |
| **Async consistency** | ✅ All adapter methods return Promises |
| **Optional chaining** | ✅ Used throughout |
| **Dependency injection** | ✅ Adapters, LLMs, and stores are injected |
| **Code comments** | ✅ JSDoc on all public APIs, section headers |
| **Magic strings** | ⚠️ Adapter names ("sqlite", "chroma", "s3") could be enum |
| **Test coverage** | ⚠️ Integration test setup exists but test files sparse |
| **Security** | ⚠️ Auth/RBAC middleware are stubs; PBKDF2 auth in sync server |

## 8. Anti-Patterns to Note

- **Silent catch blocks** — Several `catch {}` swallow errors without logging (non-fatal operations)
- **God file** — `agent-wiki-mw/src/server.ts` is 2200+ lines; could be split into route modules
- **Dynamic imports** — Used to avoid top-level `bun:sqlite` at module load, but makes dependency graph harder to trace
- **Hardcoded credentials** — Default MW password and MinIO keys in source (acceptable for dev, needs rotation for prod)
