/**
 * @openfs/wasm
 *
 * One import. One call. Sandboxed virtual filesystem for AI agents.
 *
 * Works in: Browser, Node.js, Bun, Deno, any WASM runtime.
 * No native code. No real filesystem access. Fully isolated.
 *
 * Usage:
 *   const fs = await createAgentFs({ "/docs/auth.md": "# Auth..." });
 *   const { stdout } = await fs.exec("grep -r 'token' /docs");
 */

import { Bash } from "just-bash";
import { createOpenFs, PathTree } from "@openfs/core";
import { parseGrepFlags, optimizeGrep, rewriteGrepCommand } from "@openfs/grep-optimizer";
import { SqliteWasmAdapter } from "./adapter.js";

export { SqliteWasmAdapter } from "./adapter.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** true when grep ran through the coarse→prefetch optimizer */
  optimized?: boolean;
}

export interface AgentFs {
  /** Run any shell command: ls, cat, grep, head, stat, find */
  exec(command: string): Promise<ExecResult>;
  /** Full-text search across all files — returns matching paths */
  search(query: string): Promise<string[]>;
  /** Read a file directly */
  read(path: string): Promise<string>;
  /** List a directory */
  ls(path?: string): Promise<string[]>;
  /** Check if a path exists */
  exists(path: string): boolean;
  /** Add or update files at runtime */
  ingest(files: Record<string, string>): Promise<void>;
  /** Delete a file */
  remove(path: string): Promise<void>;
  /** Adapter stats */
  stats(): { fileCount: number; totalSize: number; chunkCount: number };
  /** Export DB snapshot (useful for saving to IndexedDB / disk) */
  export(): Uint8Array;
  /** Run a raw SQL query — returns rows as objects (SELECT) */
  query(sql: string): Record<string, unknown>[];
  /** Run a SQL statement — DDL/DML (CREATE TABLE, INSERT, UPDATE, DELETE) */
  run(sql: string, params?: unknown[]): void;
  /** Shut down and free WASM memory */
  close(): Promise<void>;
}

// ── Factory ────────────────────────────────────────────────────────────────────

export interface CreateAgentFsOptions {
  /** Initial document set — { "/path/to/file.md": "content" } */
  docs?: Record<string, string>;
  /** RBAC: restrict paths to specific user groups */
  userGroups?: string[];
  /** Path to sql.js WASM binary (optional — defaults to CDN/bundler resolution) */
  wasmPath?: string;
  /** Allow write operations (default: false — EROFS) */
  writable?: boolean;
  /** Restore from a previously exported snapshot (Uint8Array from fs.export()) */
  initialData?: Uint8Array;
}

export async function createAgentFs(
  docsOrOptions: Record<string, string> | CreateAgentFsOptions = {},
): Promise<AgentFs> {
  // Accept bare docs object or full options
  const isDocsMap =
    !("docs" in docsOrOptions) &&
    !("wasmPath" in docsOrOptions) &&
    !("userGroups" in docsOrOptions);

  const opts: CreateAgentFsOptions = isDocsMap
    ? { docs: docsOrOptions as Record<string, string> }
    : (docsOrOptions as CreateAgentFsOptions);

  // ── 1. Boot WASM SQLite ────────────────────────────────────────────────────
  const adapter = await SqliteWasmAdapter.create(opts.wasmPath, opts.initialData);

  // ── 2. Ingest initial docs ─────────────────────────────────────────────────
  if (opts.docs && Object.keys(opts.docs).length > 0) {
    adapter.ingestDirectory(opts.docs);
  }

  // ── 3. Build path tree ─────────────────────────────────────────────────────
  let pathMap = await adapter.init({ userGroups: opts.userGroups });
  const tree = new PathTree();
  tree.build(pathMap);

  // ── 4. Create bash instance ────────────────────────────────────────────────
  const openfs = createOpenFs(adapter, { pathTree: tree, writable: opts.writable });
  const bash   = new Bash({ fs: openfs, cwd: "/" });

  // ── 5. Return agent interface ──────────────────────────────────────────────
  return {
    async exec(command: string): Promise<ExecResult> {
      // Grep optimizer: FTS5 coarse filter → prefetch → just-bash fine filter
      let finalCommand = command;
      let optimized = false;
      const trimmed = command.trim();
      if (trimmed.startsWith("grep ") || trimmed.startsWith("grep\t")) {
        const grepArgs = trimmed.slice(5).trim().split(/\s+/);
        const flags = parseGrepFlags(grepArgs);
        if (flags.pattern && flags.paths.length > 0) {
          const { candidates } = await optimizeGrep(adapter, flags);
          if (candidates.length === 0) {
            return { stdout: "", stderr: "", exitCode: 1, optimized: true };
          }
          const rewritten = rewriteGrepCommand(grepArgs, candidates.map(c => c.path));
          finalCommand = "grep " + rewritten.join(" ");
          optimized = true;
        }
      }

      const result = await bash.exec(finalCommand);
      // After any write op, rebuild path tree so ls/find/stat stay in sync
      if (opts.writable) {
        pathMap = await adapter.init({ userGroups: opts.userGroups });
        tree.build(pathMap);
      }
      return {
        stdout:    result.stdout,
        stderr:    result.stderr,
        exitCode:  result.exitCode,
        optimized,
      };
    },

    async search(query: string): Promise<string[]> {
      const results = await adapter.search(query);
      return results.map(r => r.path);
    },

    async read(path: string): Promise<string> {
      return adapter.readFile(path);
    },

    ls(path = "/"): Promise<string[]> {
      try {
        const entries = tree.readdir(path);
        return Promise.resolve(entries);
      } catch {
        return Promise.resolve([]);
      }
    },

    exists(path: string): boolean {
      return tree.exists(path);
    },

    async ingest(files: Record<string, string>): Promise<void> {
      adapter.ingestDirectory(files);
      pathMap = await adapter.init({ userGroups: opts.userGroups });
      tree.build(pathMap);
    },

    async remove(path: string): Promise<void> {
      await adapter.deleteFile(path);
      pathMap = await adapter.init({ userGroups: opts.userGroups });
      tree.build(pathMap);
    },

    query(sql: string): Record<string, unknown>[] {
      return adapter.query(sql);
    },

    run(sql: string, params: unknown[] = []): void {
      adapter.run(sql, params);
    },

    stats() {
      return adapter.getStats();
    },

    export(): Uint8Array {
      return adapter.export();
    },

    async close(): Promise<void> {
      await adapter.close();
    },
  };
}

/**
 * Minimal adapter contract for `createAgentFsFromAdapter`.
 * Compatible with `@openfs/adapter-sqlite`, `@openfs/adapter-chroma`, etc.
 */
export interface ServerAdapterLike {
  readonly name: string;
  init(options?: { userGroups?: string[] }): Promise<Map<string, { isPublic: boolean; groups: string[] }>>;
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  getFileMeta(path: string): Promise<{ path: string; isPublic: boolean; groups: string[]; size: number; mtime: Date; chunkCount: number }>;
  search(query: string, flags?: Record<string, unknown>): Promise<Array<{ path: string; chunkIndices?: number[] }>>;
  bulkPrefetch(paths: string[]): Promise<Map<string, string>>;
  writeFile?(path: string, content: string): Promise<void>;
  deleteFile?(path: string): Promise<void>;
  close(): Promise<void>;
  query(sql: string, params?: unknown[]): Record<string, unknown>[];
  run(sql: string, params?: unknown[]): void;
  export(): Uint8Array;
  ingestDirectory(files: Record<string, string>, meta?: { isPublic?: boolean; groups?: string[] }): void;
  getStats(): { fileCount: number; totalSize: number; chunkCount: number };
}

/**
 * createAgentFsFromAdapter — wrap any OpenFsAdapter into the AgentFs interface.
 *
 * Use this on the server to plug in the native bun:sqlite adapter for
 * disk-persisted storage, while keeping createAgentFs (WASM) for the browser.
 *
 * Example (server / Bun):
 *   import { SqliteAdapter } from "@openfs/adapter-sqlite";
 *   const adapter = new SqliteAdapter({ dbPath: "./openfs.db" });
 *   const fs = await createAgentFsFromAdapter(adapter, { writable: true });
 */
export async function createAgentFsFromAdapter(
  adapter: ServerAdapterLike,
  opts: { writable?: boolean; userGroups?: string[] } = {},
): Promise<AgentFs> {
  let pathMap = await adapter.init({ userGroups: opts.userGroups });
  const tree = new PathTree();
  tree.build(pathMap);
  const openfs = createOpenFs(adapter as any, { pathTree: tree, writable: opts.writable });
  const bash   = new Bash({ fs: openfs, cwd: "/" });

  return {
    async exec(command: string): Promise<ExecResult> {
      const result = await bash.exec(command);
      if (opts.writable) {
        pathMap = await adapter.init({ userGroups: opts.userGroups });
        tree.build(pathMap);
      }
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
    async search(query: string): Promise<string[]> {
      const results = await adapter.search(query);
      return results.map(r => r.path);
    },
    async read(path: string): Promise<string> { return adapter.readFile(path); },
    ls(path = "/"): Promise<string[]> {
      try { return Promise.resolve(tree.readdir(path)); } catch { return Promise.resolve([]); }
    },
    exists(path: string): boolean { return tree.exists(path); },
    async ingest(files: Record<string, string>): Promise<void> {
      adapter.ingestDirectory(files);
      pathMap = await adapter.init({ userGroups: opts.userGroups });
      tree.build(pathMap);
    },
    async remove(path: string): Promise<void> {
      if (!adapter.deleteFile) throw new Error("EROFS: adapter does not support delete");
      await adapter.deleteFile(path);
      pathMap = await adapter.init({ userGroups: opts.userGroups });
      tree.build(pathMap);
    },
    query(sql: string): Record<string, unknown>[] { return adapter.query(sql); },
    run(sql: string, params: unknown[] = []): void { adapter.run(sql, params); },
    stats() { return adapter.getStats(); },
    export(): Uint8Array { return adapter.export(); },
    async close(): Promise<void> { await adapter.close(); },
  };
}
