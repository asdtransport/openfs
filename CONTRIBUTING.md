# Contributing to OpenFS

Welcome! OpenFS is a community-driven project. Every adapter is a self-contained package, so contributions are scoped and easy to review.

## Quick Start

```bash
git clone https://github.com/openfs-community/openfs
cd openfs
pnpm install
bun test tests/integration.test.ts   # SQLite + just-bash (31 tests)
```

### With Chroma (docker-compose)

```bash
docker compose up -d
docker compose exec openfs bun test tests/integration.test.ts  # SQLite tests
docker compose exec openfs bun test tests/chroma.test.ts        # Chroma tests
```

### Or run Chroma locally

```bash
pip install chromadb
chroma run --path ./chroma_data &
CHROMA_URL=http://localhost:8000 bun test tests/chroma.test.ts
```

## Contribution Areas

### 1. New Adapters (most impactful)

Each adapter implements `OpenFsAdapter` from `@openfs/core`:

```
packages/adapter-YOUR-DB/
├── package.json
├── src/
│   ├── index.ts          # exports
│   └── your-adapter.ts   # implements OpenFsAdapter
└── tsconfig.json
```

The interface has 8 required methods: `init`, `readFile`, `readFileBuffer`, `getFileMeta`, `search`, `bulkPrefetch`, `close`, and `name`.

**Currently stubbed — ready for your PR:**
- `adapter-mysql` — Use FULLTEXT indexes for grep
- `adapter-postgres` — Use tsvector + pg_trgm for grep
- `adapter-turso` — Edge-native libSQL with FTS5
- `adapter-s3` — S3/R2 blob storage

### 2. Grep Optimizer Strategies

Each backing store has different full-text search. Add a strategy in:

```
packages/grep-optimizer/src/strategies/your-db.ts
```

### 3. Python Indexer Loaders

Add loaders to ingest content from new sources:

```
packages/indexer/src/loaders/your-source.py
```

Ideas: OpenAPI specs, Git repos, Confluence, Notion, RSS feeds.

### 4. Examples

```
examples/your-example/
├── package.json
├── README.md
└── index.ts
```

## Development

- **Runtime:** Bun (bun:sqlite for SQLite adapter)
- **Package manager:** pnpm with workspaces
- **Testing:** bun:test
- **DB adapters use native drivers** — bun:sqlite, chromadb SDK, etc.

## Code Style

- TypeScript strict mode
- Async adapters (even when wrapping sync drivers like bun:sqlite)
- POSIX error codes: ENOENT, EROFS, EISDIR, ENOTDIR, ENOSYS
- Every write operation checks `writable` flag → EROFS if read-only

## License

Apache-2.0. By contributing, you agree your contributions are licensed under the same.
