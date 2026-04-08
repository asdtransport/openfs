# OpenFS — End-User Applications & Business Functions

## Primary Business Function

**Enterprise AI Knowledge Management** — OpenFS transforms unstructured data across multiple storage backends into a queryable, AI-accessible knowledge base with a familiar shell interface.

## End-User Applications

### 1. AI Agent Filesystem Sandbox

**Users**: AI/ML engineers, LLM application developers

- Gives LLM agents filesystem access without real OS sandboxes
- Agents run `ls`, `cat`, `grep`, `find` over virtual files backed by databases
- Zero container overhead — runs in-process or in-browser via WASM
- Sub-millisecond read latency vs. container filesystem I/O

**Business value**: Reduces infrastructure cost and latency for AI agent workloads.

### 2. LLM-Powered Wiki Engine (AgentWiki)

**Users**: Knowledge workers, enterprise teams

- Ingests raw documents (markdown, PDF, DOCX, XLSX, CSV, URLs)
- LLM synthesizes structured wiki pages with cross-references
- Knowledge compounds over time — new sources update existing pages
- RAG Q&A: ask questions, get cited answers from the wiki
- Quality control: automated lint checks for orphans, contradictions, stale content
- Activity log tracks all operations

**Business value**: Automates knowledge base creation and maintenance; eliminates manual wiki curation.

### 3. MediaWiki Integration (Bidirectional Sync)

**Users**: Organizations running MediaWiki

- **Pull**: imports all MediaWiki pages into OpenFS as sources
- **Push**: writes LLM-synthesized pages back to MediaWiki
- **Incremental sync**: polls for recent changes and re-ingests
- Category tagging distinguishes human-written from AI-synthesized pages

**Business value**: Augments existing MediaWiki installations with AI capabilities without replacing them.

### 4. S3/MinIO Object Storage Management

**Users**: DevOps, data engineers

- Full S3 management API (Python FastAPI): buckets, objects, IAM, analytics, monitoring
- CLI commands in the terminal: `s3 buckets`, `s3 ls`, `s3 cat`, `s3 put`
- Dashboard and metrics endpoints
- Proxied through the Hono server to avoid CORS

**Business value**: Unified interface for object storage management alongside knowledge operations.

### 5. Knowledge Graph Pipeline

**Users**: Data scientists, knowledge engineers

- Bulk ingest from S3 buckets (handles PDF, DOCX, XLSX, CSV, HTML, text)
- Smart chunking with semantic boundary detection (headings > paragraphs > sentences)
- Real vector embeddings via OpenAI `text-embedding-3-small` stored in ChromaDB
- LLM entity extraction: people, organizations, concepts, technologies
- Relationship mapping between entities
- Topic expansion: search → synthesize → wiki page

**Business value**: Transforms bulk document stores into structured, searchable knowledge graphs.

### 6. Multi-Channel Access

| Channel | Interface | Key Capability |
|---------|-----------|---------------|
| **Browser** | Astro playground with xterm.js | Interactive terminal, adapter switching |
| **REST API** | Hono server on port 4321 | Programmatic access for integrations |
| **Telegram** | grammY bot | Mobile Q&A, ingest URLs, grep/search |
| **CLI** | `agent-wiki-mw` CLI tool | Pull/push/query/ingest from command line |

### 7. Document Normalization

- SpreadsheetLLM-inspired XLSX processing: merged cell expansion, header detection, markdown table output
- PDF extraction with layout preservation
- DOCX → clean markdown
- Customizable LLM normalization prompts per file type (stored in SQLite)

## Revenue/Deployment Models

Based on the architecture, OpenFS could serve:

1. **Self-hosted enterprise tool** — Docker Compose deploys the full stack
2. **Developer SDK** — `@openfs/wasm` as an npm package for embedding in apps
3. **Knowledge-as-a-Service** — the sync server + wiki engine as a managed product
4. **AI agent infrastructure** — the core + adapters as middleware for LLM applications
