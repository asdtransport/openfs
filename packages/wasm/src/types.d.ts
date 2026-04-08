/**
 * @openfs/wasm — Public type declarations
 *
 * Hand-maintained bundled declarations for npm publish.
 * These mirror the interfaces in index.ts and adapter.ts exactly.
 */

// ── ExecResult ──────────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** true when grep ran through the coarse→prefetch optimizer */
  optimized?: boolean;
}

// ── AgentFs ─────────────────────────────────────────────────────────────────────

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

// ── CreateAgentFsOptions ────────────────────────────────────────────────────────

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

// ── ServerAdapterLike ───────────────────────────────────────────────────────────

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

// ── SqliteWasmAdapter ───────────────────────────────────────────────────────────

export declare class SqliteWasmAdapter {
  readonly name: string;

  /** Factory — async because WASM init is async.
   *  Pass `initialData` to restore a previously exported snapshot (e.g. from IndexedDB). */
  static create(wasmPath?: string, initialData?: Uint8Array): Promise<SqliteWasmAdapter>;

  /** Run a SQL statement */
  run(sql: string, params?: unknown[]): void;

  /** Run a SQL query — returns rows as objects */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];

  /** Batch ingest files */
  ingestDirectory(
    files: Record<string, string>,
    meta?: { isPublic?: boolean; groups?: string[] },
  ): void;

  /** Async alias for ingestDirectory */
  ingestDocuments(
    files: Record<string, string>,
    meta?: { isPublic?: boolean; groups?: string[] },
  ): Promise<void>;

  /** Initialize adapter and return path tree */
  init(options?: { userGroups?: string[] }): Promise<Map<string, { isPublic: boolean; groups: string[] }>>;

  /** Read file content */
  readFile(path: string): Promise<string>;

  /** Read file as binary */
  readFileBuffer(path: string): Promise<Uint8Array>;

  /** Get file metadata */
  getFileMeta(path: string): Promise<{
    path: string;
    isPublic: boolean;
    groups: string[];
    size: number;
    mtime: Date;
    chunkCount: number;
  }>;

  /** Coarse search using FTS5 or LIKE fallback */
  search(query: string, flags?: Record<string, unknown>): Promise<Array<{ path: string }>>;

  /** Bulk prefetch files for grep optimization */
  bulkPrefetch(paths: string[]): Promise<Map<string, string>>;

  /** Write a single file */
  writeFile(path: string, content: string): Promise<void>;

  /** Delete a file */
  deleteFile(path: string): Promise<void>;

  /** Get stats: file count, total size, chunk count */
  getStats(): { fileCount: number; totalSize: number; chunkCount: number };

  /** Export DB as Uint8Array */
  export(): Uint8Array;

  /** Close the database */
  close(): Promise<void>;
}

// ── Factory functions ───────────────────────────────────────────────────────────

/**
 * Create a sandboxed virtual filesystem for AI agents.
 * Works in: Browser, Node.js, Bun, Deno, any WASM runtime.
 *
 * @example
 * const fs = await createAgentFs({ "/docs/auth.md": "# Auth..." });
 * const { stdout } = await fs.exec("grep -r 'token' /docs");
 */
export declare function createAgentFs(
  docsOrOptions?: Record<string, string> | CreateAgentFsOptions,
): Promise<AgentFs>;

/**
 * Wrap any server-side OpenFsAdapter into the AgentFs interface.
 * Use for disk-persisted storage via bun:sqlite, Chroma, or S3 adapters.
 *
 * @example
 * import { SqliteAdapter } from "@openfs/adapter-sqlite";
 * const adapter = new SqliteAdapter({ dbPath: "./openfs.db" });
 * const fs = await createAgentFsFromAdapter(adapter, { writable: true });
 */
export declare function createAgentFsFromAdapter(
  adapter: ServerAdapterLike,
  opts?: { writable?: boolean; userGroups?: string[] },
): Promise<AgentFs>;
