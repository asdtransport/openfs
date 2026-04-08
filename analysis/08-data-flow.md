# OpenFS — Data Flow Diagrams

## 1. Shell Command Execution (WASM Mode)

```
User types "grep -r token /docs"
        │
        ▼
  ┌─────────────┐
  │  xterm.js   │  Browser terminal captures input
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  AgentFs     │  createAgentFs() facade
  │  .exec()     │
  └──────┬──────┘
         │  Detects grep command
         ▼
  ┌──────────────────┐
  │  Grep Optimizer   │
  │  parseGrepFlags() │
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │  adapter.search() │  FTS5 MATCH "token"
  │  (coarse filter)  │  → 3 candidate files
  └──────┬───────────┘
         │
         ▼
  ┌────────────────────┐
  │  bulkPrefetch()     │  Load 3 files into memory
  └──────┬─────────────┘
         │
         ▼
  ┌────────────────────┐
  │  rewriteGrepCommand │  "grep -r token /docs" →
  │                      │  "grep token /docs/a.md /docs/b.md /docs/c.md"
  └──────┬─────────────┘
         │
         ▼
  ┌──────────────┐
  │  just-bash    │  Runs grep over prefetched files
  │  .exec()      │  → stdout with matches
  └──────┬───────┘
         │
         ▼
  ┌─────────────┐
  │  xterm.js   │  Renders colored output
  └─────────────┘
```

## 2. Document Ingestion (AgentWiki)

```
Raw document (markdown, URL, file)
        │
        ▼
  ┌──────────────┐
  │  AgentWiki    │
  │  .ingest()    │
  └──────┬───────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
  Store in    FTS search for
  /sources/   related wiki pages
    │         │
    │         ▼
    │    Read related pages
    │    (up to 8)
    │         │
    └────┬────┘
         │
         ▼
  ┌────────────────┐
  │  LLM (Claude/   │  System: "wiki maintainer"
  │   GPT-4o)       │  Prompt: schema + source + existing pages
  └──────┬─────────┘
         │
         ▼
  JSON response:
  { pages: [{path, content}], summary }
         │
    ┌────┴────┐
    │         │
    ▼         ▼
  Write to   Append to
  /wiki/*.md  /wiki/log.md
```

## 3. MediaWiki Sync Loop

```
  ┌─────────────────────────────────────────────┐
  │              Boot Sequence                    │
  │                                               │
  │  1. Login to MediaWiki (MwBot)                │
  │  2. Init SqliteAdapter (disk-persisted)       │
  │  3. Create AgentWiki instance                 │
  │  4. Pull all MW pages → /sources/mw/*.md      │
  │  5. LLM synthesizes → /wiki/*.md              │
  │  6. Push synthesized → MW (Category tagged)   │
  │  7. Start 60-second polling loop              │
  └─────────────────────────────────────────────┘

  Every 60 seconds:
  ┌──────────────────┐     ┌──────────────┐
  │  MW Recent        │────▶│  Re-ingest    │
  │  Changes API      │     │  changed pages│
  └──────────────────┘     └──────┬───────┘
                                   │
                                   ▼
                            LLM re-synthesizes
                            affected wiki pages
                                   │
                                   ▼
                            Push updates to MW
                            (Category: OpenFS Synthesized)
```

## 4. S3 Knowledge Pipeline

```
  S3 Bucket (1000s of files)
        │
        ▼
  ┌──────────────────┐
  │  ListObjectsV2    │  Filter by prefix + extension
  └──────┬───────────┘
         │
         ▼  (for each file)
  ┌──────────────────┐
  │  GetObjectCommand │  Read bytes
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │  extractText()    │  PDF→text, DOCX→md, XLSX→md tables
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │  chunkDocument()  │  Semantic boundaries: H2 > ¶ > sentence
  │  (1200 chars,     │  Overlapping chunks (200 char overlap)
  │   200 overlap)    │
  └──────┬───────────┘
         │
    ┌────┼────────────────┐
    │    │                 │
    ▼    ▼                 ▼
  Chroma  KG Builder     AgentWiki
  upsert  extract         .ingest()
  chunks  entities        → wiki pages
    │    │                 │
    │    ▼                 │
    │  mergeGraph()        │
    │  → /kg/entities/     │
    │  → /kg/clusters/     │
    └────┴─────────────────┘
```

## 5. Agentic Q&A Loop (/query-agent)

```
  User question
        │
        ▼
  ┌──────────────────┐
  │  Claude API       │  System: "OpenFS AI agent"
  │  (tool-calling)   │  Tools: 11 available
  └──────┬───────────┘
         │
         ▼  (up to 8 turns)
  ┌──────────────────────────────┐
  │  Tool calls (parallel):       │
  │  • semantic_search → Chroma   │
  │  • grep_wiki → FTS5           │
  │  • read_page → OpenFS read    │
  │  • ingest_url → fetch+synth   │
  │  • expand_topic → search+wiki │
  │  • embed_wiki → Chroma upsert │
  │  • push_page → MW sync        │
  │  • run_lint → quality audit    │
  │  • read_log / append_log      │
  └──────────────┬───────────────┘
                 │
                 ▼
  Tool results fed back to Claude
  → next turn or final answer
                 │
                 ▼
  { answer, citations }
```
