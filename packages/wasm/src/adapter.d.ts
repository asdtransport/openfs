/**
 * @openfs/wasm/adapter — SqliteWasmAdapter type declarations
 *
 * Hand-maintained to avoid pulling in @openfs/core as a type dependency.
 * Consumers who import the "/adapter" subpath get full typings without
 * needing @openfs/core installed.
 */

export declare class SqliteWasmAdapter {
  readonly name: string;

  /**
   * Factory — async because WASM init is async.
   * Pass `initialData` to restore a previously exported snapshot (e.g. from IndexedDB).
   */
  static create(wasmPath?: string, initialData?: Uint8Array): Promise<SqliteWasmAdapter>;

  /** Run a SQL statement */
  run(sql: string, params?: unknown[]): void;

  /** Run a SQL query — returns rows as objects */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];

  /** Batch ingest files into the virtual filesystem */
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

  /** Coarse search using FTS5 or LIKE fallback — returns matching file paths */
  search(query: string, flags?: Record<string, unknown>): Promise<Array<{ path: string }>>;

  /** Bulk prefetch files — used by the grep optimizer */
  bulkPrefetch(paths: string[]): Promise<Map<string, string>>;

  /** Write a single file */
  writeFile(path: string, content: string): Promise<void>;

  /** Delete a file */
  deleteFile(path: string): Promise<void>;

  /** Get stats: file count, total size, chunk count */
  getStats(): { fileCount: number; totalSize: number; chunkCount: number };

  /** Export DB as Uint8Array — useful for persisting to disk or IndexedDB */
  export(): Uint8Array;

  /** Close the database and free WASM memory */
  close(): Promise<void>;
}
