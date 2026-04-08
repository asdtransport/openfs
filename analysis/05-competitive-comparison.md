# OpenFS — Competitive Comparison & Unique Functions

## Comparable Products

### 1. E2B (e2b.dev) — AI Code Sandboxes

**What it does**: Provides cloud-hosted sandboxed environments for AI agents to execute code.

| Dimension | E2B | OpenFS |
|-----------|-----|--------|
| Approach | Real VM/container sandboxes | Virtual filesystem over databases |
| Latency | ~500ms cold start, ~50ms warm | Sub-millisecond (in-process) |
| Cost | Per-sandbox billing | Zero infrastructure cost (WASM) |
| Write support | Full OS write access | Optional, adapter-dependent |
| Search | Standard `grep` over real files | Optimized: FTS5/vector → regex pipeline |
| Browser support | No (server-side only) | Yes (sql.js WASM) |
| RBAC | OS-level permissions | Path-level group pruning |

**OpenFS advantage**: No sandbox overhead; works in-browser; search is orders of magnitude faster on large corpora.

### 2. MemFS / memfs (npm) — In-Memory Filesystem

**What it does**: Pure JavaScript in-memory filesystem implementing Node.js `fs` API.

| Dimension | memfs | OpenFS |
|-----------|-------|--------|
| Persistence | None (memory only) | SQLite, Chroma, S3 |
| Search | None built-in | FTS5, vector search, $contains |
| Multi-backend | No | 4 adapters (SQLite, Chroma, S3, WASM) |
| Shell commands | No | Full `just-bash` (ls, grep, find, etc.) |
| AI integration | No | LLM wiki synthesis, RAG, knowledge graphs |

**OpenFS advantage**: Persistent, searchable, AI-native. memfs is a test utility; OpenFS is a production knowledge system.

### 3. LlamaIndex / LangChain — RAG Frameworks

**What they do**: Orchestrate LLM interactions with retrieval-augmented generation.

| Dimension | LlamaIndex/LangChain | OpenFS |
|-----------|---------------------|--------|
| Primary metaphor | Indexes, chains, agents | Filesystem (ls, cat, grep) |
| Storage | Pluggable vector stores | Pluggable adapters (SQL + vector + object) |
| Shell interface | No | Yes — standard UNIX commands |
| Knowledge compounding | No built-in wiki | AgentWiki: sources → LLM synthesis → wiki |
| MediaWiki sync | No | Bidirectional pull/push |
| Browser runtime | Limited | Full WASM runtime |

**OpenFS advantage**: The filesystem metaphor is uniquely intuitive for AI agents already trained on shell usage. Knowledge compounds over time via the wiki engine rather than being stateless retrieval.

### 4. Obsidian / Notion AI — Knowledge Management

**What they do**: Note-taking and knowledge management with AI features.

| Dimension | Obsidian/Notion | OpenFS |
|-----------|-----------------|--------|
| Target user | Humans | AI agents (with human oversight) |
| Input | Manual typing | Automated ingestion from S3, URLs, MediaWiki |
| AI role | Assistant (summarize, complete) | Primary author (synthesize, cross-reference, lint) |
| API access | Limited | Full REST + shell + Telegram |
| Self-hosted | Obsidian yes, Notion no | Fully self-hosted (Docker Compose) |

**OpenFS advantage**: AI-first rather than AI-assisted. The LLM is the primary knowledge curator, not just a helper.

## Unique Functions (Not Found in Competitors)

### 1. Grep Optimization Pipeline

No other virtual filesystem implements a **coarse → prefetch → fine** search pipeline. This turns database-backed grep from O(n) full scan to O(k) targeted regex, making it viable on large corpora (thousands of files).

### 2. Adapter-Agnostic Shell

The same `grep -r "token" /docs` command works identically across SQLite (FTS5), ChromaDB ($contains), and S3 (in-memory scan). The user doesn't know or care which backend is active. No other tool provides this level of backend transparency for shell commands.

### 3. WASM + Server Parity

The same adapter interface runs both in-browser (sql.js WASM) and on the server (bun:sqlite). The `SqliteWasmAdapter` is a drop-in replacement for `SqliteAdapter`. This enables:
- Client-side demos with zero infrastructure
- Progressive enhancement to server-side storage
- Offline-capable AI agent applications

### 4. LLM Wiki Synthesis with Source Immutability

AgentWiki's `/sources/` → `/wiki/` architecture is unique:
- Raw sources are **immutable** — never modified after ingestion
- Wiki pages are **LLM-synthesized** — the AI decides how to organize knowledge
- New sources **compound** existing pages — cross-references update automatically
- Contradictions are **flagged** — lint system detects conflicts between pages

### 5. MediaWiki ↔ AI Bidirectional Sync

No other tool bridges MediaWiki with an LLM knowledge engine:
- Pull human-written wiki pages → LLM synthesizes structured versions
- Push synthesized pages back → tagged as `[[Category:OpenFS Synthesized]]`
- Recent changes polling keeps the two systems in sync
- Clear provenance: human vs. AI-generated content is always distinguishable

### 6. Knowledge Graph from Documents

The `agent-knowledge` pipeline extracts entities and relationships from document chunks using LLM, builds a graph, and stores it as browsable markdown files. This goes beyond simple RAG into **structural knowledge representation**.

### 7. SpreadsheetLLM-Inspired XLSX Processing

The file extractor handles messy enterprise spreadsheets:
- Expands merged cells
- Auto-detects header rows (≥60% string heuristic)
- Renders as markdown tables (LLMs read these natively)
- Skips blank rows, title banners, logos

### 8. Multi-Channel Unified Knowledge Access

Browser terminal + REST API + Telegram bot + CLI all access the same knowledge base with the same capabilities. The Telegram bot is particularly novel — paste a URL and the system fetches, extracts, synthesizes wiki pages, and pushes them to MediaWiki automatically.

## Market Positioning

OpenFS occupies a **unique niche** at the intersection of:
- **AI agent infrastructure** (like E2B)
- **Knowledge management** (like Obsidian/Notion)
- **RAG frameworks** (like LlamaIndex)
- **Enterprise wiki** (like MediaWiki/Confluence)

No single competitor covers all four. The filesystem metaphor is the unifying abstraction that makes this possible.
