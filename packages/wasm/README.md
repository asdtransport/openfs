# @openfs/wasm

**Sandboxed virtual filesystem for AI agents.** One import, one call — runs in Browser, Node.js, Bun, Deno. No native code, no containers, no sandbox overhead.

Give your LLM agent a filesystem in 3 lines:

```typescript
import { createAgentFs } from "@openfs/wasm";

const fs = await createAgentFs({
  "/docs/auth.md": "# Auth\n\nUse Bearer tokens for API requests.",
  "/docs/api.md":  "# API\n\nPOST /users — create user\nGET /users/:id",
});

const { stdout } = await fs.exec("grep -r 'token' /docs");
// → /docs/auth.md:Use Bearer tokens for API requests.
```

## Features

- **Full shell** — `ls`, `cat`, `grep`, `find`, `head`, `tail`, `stat`, `wc` via [just-bash](https://github.com/nicholasgriffintn/just-bash)
- **FTS5 search** — SQLite full-text search built-in, falls back to LIKE scan
- **Grep optimizer** — two-phase pipeline: FTS5 coarse filter → regex fine filter (10-100x faster on large corpora)
- **RBAC** — path-level access control via user groups
- **Zero native code** — sql.js WASM, runs anywhere JavaScript runs
- **Snapshot/restore** — export DB to `Uint8Array`, restore from IndexedDB or disk
- **Sub-millisecond reads** — database-backed, no filesystem I/O

## Install

```bash
npm install @openfs/wasm
# or
pnpm add @openfs/wasm
# or
bun add @openfs/wasm
```

## Quick Start

### Basic Usage

```typescript
import { createAgentFs } from "@openfs/wasm";

const fs = await createAgentFs({
  "/docs/auth.md": "# Authentication\n\nBearer token required.",
  "/docs/api.md":  "# API Reference\n\nPOST /users — create user",
});

// Shell commands
await fs.exec("ls /docs");          // { stdout: "api.md\nauth.md\n" }
await fs.exec("cat /docs/auth.md"); // { stdout: "# Authentication\n..." }
await fs.exec("grep -ri 'user' /docs"); // grep with optimizer

// Direct API
await fs.search("authentication");  // ["/docs/auth.md"]
await fs.read("/docs/api.md");      // "# API Reference\n..."
await fs.ls("/docs");               // ["api.md", "auth.md"]
fs.exists("/docs/auth.md");         // true
```

### Add Files at Runtime

```typescript
await fs.ingest({
  "/docs/webhooks.md": "# Webhooks\n\nHMAC-SHA256 signatures.",
});

await fs.exec("ls /docs");
// → api.md  auth.md  webhooks.md
```

### Full-Text Search

```typescript
const paths = await fs.search("authentication token");
// → ["/docs/auth.md"]
```

### Writable Mode

```typescript
const fs = await createAgentFs({
  docs: { "/notes/hello.md": "# Hello" },
  writable: true,
});

await fs.ingest({ "/notes/world.md": "# World" });
await fs.remove("/notes/hello.md");
```

### Snapshot & Restore

```typescript
// Export
const snapshot = fs.export(); // Uint8Array
localStorage.setItem("openfs", btoa(String.fromCharCode(...snapshot)));

// Restore
const data = Uint8Array.from(atob(localStorage.getItem("openfs")!), c => c.charCodeAt(0));
const fs2 = await createAgentFs({ initialData: data });
```

### RBAC (Access Control)

```typescript
const fs = await createAgentFs({
  docs: {
    "/public/readme.md": "Public doc",
    "/private/secrets.md": "Secret doc",
  },
  userGroups: ["public"],
});

await fs.exec("ls /public");   // works
await fs.exec("ls /private");  // empty — filtered by RBAC
```

### Raw SQL Access

```typescript
const rows = fs.query("SELECT path, size FROM files ORDER BY size DESC LIMIT 5");
fs.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)");
fs.run("INSERT INTO notes (text) VALUES (?)", ["hello"]);
```

### Stats

```typescript
const { fileCount, totalSize, chunkCount } = fs.stats();
console.log(`${fileCount} files, ${(totalSize / 1024).toFixed(1)}KB`);
```

## API Reference

### `createAgentFs(docsOrOptions?)`

Creates a sandboxed filesystem instance.

**Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `docs` | `Record<string, string>` | Initial files: `{ "/path": "content" }` |
| `userGroups` | `string[]` | RBAC groups for path filtering |
| `wasmPath` | `string` | Custom path to sql.js WASM binary |
| `writable` | `boolean` | Allow write operations (default: `false`) |
| `initialData` | `Uint8Array` | Restore from a previous `fs.export()` snapshot |

You can also pass a bare docs object: `createAgentFs({ "/a.md": "..." })`.

**Returns:** `Promise<AgentFs>`

### `AgentFs` Interface

| Method | Returns | Description |
|--------|---------|-------------|
| `exec(command)` | `Promise<ExecResult>` | Run any shell command |
| `search(query)` | `Promise<string[]>` | FTS5 full-text search → matching paths |
| `read(path)` | `Promise<string>` | Read file content |
| `ls(path?)` | `Promise<string[]>` | List directory entries |
| `exists(path)` | `boolean` | Check if path exists |
| `ingest(files)` | `Promise<void>` | Add/update files |
| `remove(path)` | `Promise<void>` | Delete a file |
| `stats()` | `{ fileCount, totalSize, chunkCount }` | Adapter statistics |
| `export()` | `Uint8Array` | Export DB snapshot |
| `query(sql)` | `Record<string, unknown>[]` | Run raw SQL SELECT |
| `run(sql, params?)` | `void` | Run raw SQL DDL/DML |
| `close()` | `Promise<void>` | Free WASM memory |

### `ExecResult`

```typescript
interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  optimized?: boolean; // true if grep ran through the optimizer
}
```

## Browser Usage

In the browser, load sql.js from a CDN before importing `@openfs/wasm`:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.12.0/sql-wasm.js"></script>
<script type="module">
  import { createAgentFs } from "@openfs/wasm";

  const fs = await createAgentFs({
    "/docs/readme.md": "# Hello from the browser!",
  });

  const { stdout } = await fs.exec("cat /docs/readme.md");
  console.log(stdout);
</script>
```

Or with a bundler (Vite, webpack, etc.), sql.js is imported automatically.

## CLI

```bash
# Interactive REPL
npx openfs

# With custom docs
npx openfs --docs ./my-docs.json

# Pipe mode
echo 'grep -r token /docs' | npx openfs
```

## How the Grep Optimizer Works

Standard grep over a virtual filesystem scans every file. OpenFS uses a **two-phase pipeline**:

1. **Coarse filter** — SQLite FTS5 `MATCH` query finds candidate files in microseconds
2. **Fine filter** — `just-bash` runs the real regex only over candidates

Result: **10-100x faster** on corpora with 100+ files.

## Advanced: Server-Side Adapters

Use `createAgentFsFromAdapter` to wrap server-side adapters (bun:sqlite, Chroma, S3) into the same `AgentFs` interface:

```typescript
import { createAgentFsFromAdapter } from "@openfs/wasm";
import { SqliteAdapter } from "@openfs/adapter-sqlite";

const adapter = new SqliteAdapter({ dbPath: "./openfs.db" });
const fs = await createAgentFsFromAdapter(adapter, { writable: true });
```

## License

Apache-2.0
