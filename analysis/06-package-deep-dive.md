# OpenFS — Package Deep Dive

## @openfs/core

**Purpose**: Defines the foundational contracts and data structures.

**Key exports**:
- `OpenFsAdapter` — interface all storage backends implement (9 methods)
- `PathTree` — in-memory directory tree with RBAC pruning
- `createOpenFs()` — wraps any adapter into a `just-bash` compatible `IFileSystem`
- `initOpenFs()` — async version that calls `adapter.init()` first

**Design notes**:
- `writeFile` and `deleteFile` are optional on the interface (read-only is first-class)
- `PathTree.build()` accepts `userGroups` to prune paths at construction time
- Path normalization ensures leading `/` and no trailing `/`
- POSIX-like errors: `ENOENT`, `EISDIR`, `EROFS`, `ENOTDIR`

---

## @openfs/adapter-sqlite

**Purpose**: High-performance SQLite adapter using `bun:sqlite`.

**Storage**: `files` table with `(path, chunk_index)` composite PK. Files can be chunked.

**Search**: FTS5 virtual table (`files_fts`) with automatic triggers for insert/update/delete sync.

**Notable features**:
- WAL mode support for concurrent reads
- `ingestDirectory()` — batch insert with transaction wrapping
- `getStats()` — file count, total size, chunk count
- Chunked file reassembly in `readFile()` via `ORDER BY chunk_index`

---

## @openfs/adapter-chroma

**Purpose**: ChromaDB vector database adapter.

**Search**: Uses `$contains` text filter (not semantic search — that's in `agent-knowledge`).

**Notable features**:
- Stores a `__path_tree__` document containing JSON path map for fast init
- Chunked file support: documents with `_chunk_N` suffix are reassembled
- `ingestDocuments()` upserts both individual docs and the path tree
- Read-only by default (no `writeFile` implementation)

---

## @openfs/adapter-s3

**Purpose**: AWS SDK S3/MinIO adapter.

**Search**: In-memory content cache — loads all objects into memory for regex scanning.

**Notable features**:
- Content cache populated on `init()` and `ingestDocuments()`
- `bulkPrefetch()` fetches multiple objects via `GetObjectCommand`
- Supports `writeFile()` (PutObject) and `deleteFile()` (DeleteObject)
- Path keys strip the bucket prefix for clean virtual paths

---

## @openfs/adapter-s3-api

**Purpose**: Full S3 management REST API in Python/FastAPI.

**Structure**: Clean layered architecture:
- `app/api/v1/` — route handlers
- `app/services/` — business logic (minio_client, iam, analytics, lifecycle, replication, search, notifications)
- `app/schemas/` — Pydantic models (file, iam, analytics, backup, lifecycle, versioning, etc.)
- `app/middleware/` — security, logging
- `app/core/` — config, logging

**Endpoints cover**: buckets, objects, IAM users, monitoring/health, metrics, dashboard, analytics, stream sessions.

---

## @openfs/grep-optimizer

**Purpose**: Accelerates grep across virtual filesystems.

**Pipeline**:
1. `parseGrepFlags()` — extracts pattern, flags (`-i`, `-r`, `-n`, `-l`, `-c`, `-v`, `-w`, `-F`), and paths
2. `optimizeGrep()` — calls `adapter.search()` for coarse filter, then `adapter.bulkPrefetch()` to cache candidates
3. `rewriteGrepCommand()` — replaces directory paths with specific candidate file paths

**Result**: `just-bash` runs grep only over pre-filtered files instead of the entire corpus.

---

## @openfs/wasm

**Purpose**: Browser-portable version of the entire stack.

**Key exports**:
- `SqliteWasmAdapter` — sql.js WASM implementation of `OpenFsAdapter`
- `createAgentFs()` — one-call factory: WASM boot → ingest → path tree → bash → AgentFs
- `createAgentFsFromAdapter()` — wraps any server-side adapter into `AgentFs`

**AgentFs interface**: `exec()`, `search()`, `read()`, `ls()`, `exists()`, `ingest()`, `remove()`, `query()` (raw SQL), `run()` (DDL/DML), `stats()`, `export()`, `close()`

**Notable**: FTS5 has graceful fallback — tries external content table, then simple FTS5, then LIKE scan. Handles WASM builds with/without FTS5 support.

---

## @openfs/agent-wiki

**Purpose**: LLM-powered knowledge base engine.

**Core class**: `AgentWiki` with factory `AgentWiki.create(fs, llm)`

**Operations**:
- `ingest(path, content)` — store source, find related pages via FTS, LLM synthesizes wiki updates
- `query(question)` — FTS search for context, LLM answers with citations, optionally persists answer
- `lint()` — LLM audits pages for contradictions, orphans, stale content, missing citations
- `pages()` / `sources()` / `readPage()` / `writePage()` / `deletePage()`

**Architecture**: Immutable `/sources/` + synthesized `/wiki/` separation. Schema file (`SCHEMA.md`) guides the LLM on conventions.

**LLM adapters**: `createClaudeAdapter()`, `createOpenAiAdapter()`, `createCustomAdapter()` — pluggable, text-in/text-out.

**JSON repair**: `parseJson()` handles markdown fences, LLM preamble, unescaped newlines in string values.

---

## @openfs/agent-wiki-mw

**Purpose**: MediaWiki ↔ OpenFS bidirectional sync server.

**Components**:
- `MwBot` — lightweight MediaWiki Action API client (login, CRUD pages, search, categories, recent changes)
- `OpenFsMwSync` — bridges MwBot with AgentWiki (pull, push, ingest+sync, query, recent changes sync)
- `server.ts` — 2200-line Hono server with 40+ endpoints

**Server features**:
- Initial full pull on boot, then polling every 60 seconds
- Synthesis map (JSON file) tracks which source pages have been LLM-processed
- Category tagging: `[[Category:OpenFS Synthesized]]` on all AI-generated pages
- NormalizeRulesStore — customizable LLM prompts per file type (xlsx, pdf, docx, csv, log, txt, md)
- UsersStore — PBKDF2 password hashing, JWT auth, default admin seeding
- FeedbackStore — thumbs up/down on Q&A answers with analytics
- Agentic tool-calling loop (`/query-agent`) with 11 tools: semantic_search, grep_wiki, read_page, ingest_url, expand_topic, embed_wiki, push_page, run_lint, read_log, append_log

---

## @openfs/agent-knowledge

**Purpose**: Large-scale document → knowledge graph pipeline.

**Components**:
- `S3KnowledgePipeline` — orchestrates: S3 list → read → chunk → embed → KG extract → wiki synthesize
- `ChromaStore` — Chroma vector store with OpenAI `text-embedding-3-small` (1536-dim, cosine)
- `KnowledgeGraphBuilder` — LLM entity/relationship extraction, graph merging, markdown serialization
- `chunkDocument()` — semantic boundary detection (headings > paragraphs > sentences > words)
- `extractText()` — PDF (@llamaindex/liteparse), DOCX (mammoth), XLSX (SheetJS), plain text

**ChromaStore capabilities**: semantic search, text search ($contains), list sources/topics/collections, paginated chunk listing, delete by chunk or source.

---

## @openfs/bot-telegram

**Purpose**: Telegram bot interface to the knowledge base.

**Framework**: grammY

**Commands**: `/start`, `/ask`, `/grep`, `/cat`, `/pages`, `/recent`, `/ingest`, `/sync`, `/status`

**UX**: Plain text messages auto-route to `/ask`. URL ingestion auto-fetches and synthesizes. Inline `::` syntax for title + content. Auth guard via `ALLOWED_CHAT_IDS`.

---

## @openfs/playground

**Purpose**: Browser-based interactive terminal UI.

**Framework**: Astro (SSG) + xterm.js + FitAddon + WebLinksAddon

**Pages**: `index.astro` (terminal), `wiki.astro`, `wasm.astro`

**Components**: `AppShell.astro` (sidebar + topbar layout), `Terminal.astro` (stub)

**Features**: Dual-mode (WASM/Server), adapter switching, command chips, connection status, command history, clipboard handling, ASCII art welcome screen.
