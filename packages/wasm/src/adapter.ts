/**
 * SqliteWasmAdapter
 *
 * SQLite compiled to WASM via sql.js — no native binaries, runs in:
 *   - Browser (via <script> or bundler)
 *   - Node.js
 *   - Bun
 *   - Deno
 *   - Any WASM runtime
 *
 * Implements the same OpenFsAdapter interface as @openfs/adapter-sqlite
 * so it's a drop-in replacement everywhere.
 */

import type {
  AdapterOptions,
  FileMeta,
  GrepFlags,
  OpenFsAdapter,
  PathTreeNode,
  SearchResult,
} from "@openfs/core";

// ── Schema (identical to bun:sqlite adapter) ──────────────────────────────────
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS files (
    path        TEXT    NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    content     TEXT    NOT NULL DEFAULT '',
    is_public   INTEGER NOT NULL DEFAULT 1,
    groups_json TEXT    NOT NULL DEFAULT '[]',
    size        INTEGER NOT NULL DEFAULT 0,
    mtime       TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (path, chunk_index)
  );
  CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
`;

// FTS5 setup — split from schema because CREATE VIRTUAL TABLE is not IF NOT EXISTS safe
const FTS_SETUP = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
   USING fts5(path, content, content='files', content_rowid='rowid')`,
  `CREATE TRIGGER IF NOT EXISTS files_ai
   AFTER INSERT ON files BEGIN
     INSERT INTO files_fts(rowid,path,content) VALUES(new.rowid,new.path,new.content);
   END`,
  `CREATE TRIGGER IF NOT EXISTS files_ad
   AFTER DELETE ON files BEGIN
     INSERT INTO files_fts(files_fts,rowid,path,content)
     VALUES('delete',old.rowid,old.path,old.content);
   END`,
  `CREATE TRIGGER IF NOT EXISTS files_au
   AFTER UPDATE ON files BEGIN
     INSERT INTO files_fts(files_fts,rowid,path,content)
     VALUES('delete',old.rowid,old.path,old.content);
     INSERT INTO files_fts(rowid,path,content) VALUES(new.rowid,new.path,new.content);
   END`,
];

export class SqliteWasmAdapter implements OpenFsAdapter {
  readonly name = "sqlite-wasm";
  private db: import("sql.js").Database;

  private constructor(db: import("sql.js").Database) {
    this.db = db;
  }

  /** Factory — async because WASM init is async.
   *  Pass `initialData` to restore a previously exported snapshot (e.g. from IndexedDB). */
  static async create(wasmPath?: string, initialData?: Uint8Array): Promise<SqliteWasmAdapter> {
    // Browser: sql.js loaded as a CDN global (set via <script> tag in the page)
    // Node/Bun: dynamically import from npm
    let initSqlJs: (config?: any) => Promise<any> =
      (globalThis as any).initSqlJs;
    if (!initSqlJs) {
      const sqljs = await import("sql.js");
      initSqlJs = (sqljs as any).default ?? (sqljs as any);
    }
    const SQL = await initSqlJs(
      wasmPath
        ? { locateFile: () => wasmPath }
        : {}
    );
    const db = initialData ? new SQL.Database(initialData) : new SQL.Database();
    const adapter = new SqliteWasmAdapter(db);
    // Check whether FTS5 was present in binary BEFORE schema runs
    const hadFts = initialData
      ? adapter.query("SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'").length > 0
      : false;
    adapter.ensureSchema();
    if (initialData && adapter["hasFts"]) {
      if (!hadFts) {
        // Binary was saved without FTS5 (stripped before export) — rebuild index now
        console.log("[adapter] FTS5 freshly created on binary load — rebuilding index from files");
        try { adapter["db"].run("INSERT INTO files_fts(files_fts) VALUES('rebuild')"); } catch { /* ignore */ }
      } else {
        // FTS5 was in binary — verify it's not corrupt
        try {
          adapter["db"].run("INSERT INTO files_fts(files_fts) VALUES('integrity-check')");
          console.log("[adapter] FTS5 integrity: OK");
        } catch {
          console.warn("[adapter] FTS5 corrupt in binary — rebuilding");
          try { adapter["db"].run("INSERT INTO files_fts(files_fts) VALUES('rebuild')"); } catch { /* ignore */ }
        }
      }
    }
    return adapter;
  }

  private hasFts = false;

  private ensureSchema(): void {
    this.db.run(SCHEMA);
    // Try FTS5 with external content table (most efficient)
    try {
      this.db.run(FTS_SETUP[0]);
      this.hasFts = true;
      console.log("[adapter] FTS5 with content table: OK");
    } catch (e1) {
      console.warn("[adapter] FTS5 content table failed:", (e1 as Error).message);
      // Fallback: try simple FTS5 without external content (stores own copy)
      try {
        this.db.run(
          `CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
           USING fts5(path, content)`
        );
        // Replace triggers to also insert content into FTS5 directly
        this.db.run(
          `CREATE TRIGGER IF NOT EXISTS files_ai
           AFTER INSERT ON files BEGIN
             INSERT INTO files_fts(path, content) VALUES(new.path, new.content);
           END`
        );
        this.db.run(
          `CREATE TRIGGER IF NOT EXISTS files_au
           AFTER UPDATE ON files BEGIN
             DELETE FROM files_fts WHERE rowid = old.rowid;
             INSERT INTO files_fts(path, content) VALUES(new.path, new.content);
           END`
        );
        this.db.run(
          `CREATE TRIGGER IF NOT EXISTS files_ad
           AFTER DELETE ON files BEGIN
             DELETE FROM files_fts WHERE rowid = old.rowid;
           END`
        );
        this.hasFts = true;
        console.log("[adapter] FTS5 simple mode: OK");
      } catch (e2) {
        console.warn("[adapter] FTS5 simple also failed:", (e2 as Error).message);
        // FTS5 truly not available in this WASM build
        this.hasFts = false;
      }
    }
    if (!this.hasFts) return;
    // If we used the external content path, also set up remaining triggers
    for (const sql of FTS_SETUP.slice(1)) {
      try { this.db.run(sql); } catch { /* already exists */ }
    }
  }

  // ── Run helper (sql.js uses .run() with array params) ──────────────────────
  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params);
  }

  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return rows;
  }

  private queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
    const rows = this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  // ── Ingest ─────────────────────────────────────────────────────────────────
  ingestDirectory(
    files: Record<string, string>,
    meta?: { isPublic?: boolean; groups?: string[] },
  ): void {
    const isPublic = meta?.isPublic !== false ? 1 : 0;
    const groups   = JSON.stringify(meta?.groups ?? []);

    this.db.run("BEGIN");
    try {
      for (const [path, content] of Object.entries(files)) {
        const size = new TextEncoder().encode(content).length;
        this.run(
          `INSERT OR REPLACE INTO files
           (path, chunk_index, content, size, is_public, groups_json, mtime)
           VALUES (?, 0, ?, ?, ?, ?, datetime('now'))`,
          [path, content, size, isPublic, groups],
        );
      }
      this.db.run("COMMIT");
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
  }

  // Async alias for OpenFsAdapter compat
  async ingestDocuments(
    files: Record<string, string>,
    meta?: { isPublic?: boolean; groups?: string[] },
  ): Promise<void> {
    this.ingestDirectory(files, meta);
  }

  // ── OpenFsAdapter ──────────────────────────────────────────────────────────
  async init(_options?: AdapterOptions): Promise<Map<string, PathTreeNode>> {
    const rows = this.query<{ path: string; is_public: number; groups_json: string }>(
      `SELECT DISTINCT path, is_public, groups_json FROM files ORDER BY path`,
    );
    const m = new Map<string, PathTreeNode>();
    for (const r of rows) {
      m.set(r.path, {
        isPublic: r.is_public === 1,
        groups: JSON.parse(r.groups_json as string),
      });
    }
    return m;
  }

  async readFile(path: string): Promise<string> {
    const rows = this.query<{ content: string }>(
      `SELECT content FROM files WHERE path = ? ORDER BY chunk_index ASC`,
      [path],
    );
    if (!rows.length) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return rows.map(r => r.content).join("");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path));
  }

  async getFileMeta(path: string): Promise<FileMeta> {
    const row = this.queryOne<{
      path: string; is_public: number; groups_json: string;
      total_size: number; mtime: string; chunk_count: number;
    }>(
      `SELECT path, is_public, groups_json,
              SUM(size) as total_size, MAX(mtime) as mtime, COUNT(*) as chunk_count
       FROM files WHERE path = ? GROUP BY path`,
      [path],
    );
    if (!row) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return {
      path: row.path,
      isPublic: row.is_public === 1,
      groups: JSON.parse(row.groups_json as string),
      size: row.total_size,
      mtime: new Date(row.mtime),
      chunkCount: row.chunk_count,
    };
  }

  async search(query: string, flags?: Partial<GrepFlags>): Promise<SearchResult[]> {
    const escaped  = query.replace(/['"]/g, "").replace(/[*(){}[\]^~?!.,;:]/g, " ");
    const STOP = new Set(["a","an","the","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","shall","can","i","we","you","he","she","it","they","me","us","him","her","them","my","our","your","his","its","their","this","that","these","those","what","which","who","how","when","where","why","and","or","not","in","on","at","by","for","of","to","from","with","as","into","up","out","if","so","but","tell","about","give","show","explain","describe","find","get","list","make","create","use","want","need","know","see","look","think","say","go","come","take"]);
    const ftsQuery = flags?.fixedStrings
      ? `"${escaped}"`
      : escaped.split(/\s+/).filter(w => w.length > 1 && !STOP.has(w.toLowerCase())).map(w => `"${w}"`).join(" OR ");

    console.log(`[adapter.search] ftsQuery="${ftsQuery}" hasFts=${this.hasFts}`);
    if (!ftsQuery.trim()) return [];

    try {
      const rows = this.query<{ path: string }>(
        `SELECT DISTINCT path FROM files_fts WHERE files_fts MATCH ? ORDER BY rank LIMIT 500`,
        [ftsQuery],
      );
      console.log(`[adapter.search] FTS5 → ${rows.length} results`);
      if (rows.length > 0) return rows.map(r => ({ path: r.path }));
      // FTS5 found nothing — fall through to LIKE for partial/fuzzy matching
    } catch (e) {
      console.warn(`[adapter.search] FTS5 failed (${(e as Error).message}), falling back to LIKE`);
    }
    // LIKE scan — handles typos/partial matches that FTS5 misses
    const terms = escaped.split(/\s+/).filter(w => w.length > 1 && !STOP.has(w.toLowerCase()));
    if (!terms.length) return [];
    const conditions = terms.map(() => "content LIKE ? OR path LIKE ?").join(" OR ");
    const params = terms.flatMap(t => [`%${t}%`, `%${t}%`]);
    const rows2 = this.query<{ path: string }>(
      `SELECT DISTINCT path FROM files WHERE ${conditions} LIMIT 500`,
      params,
    );
    console.log(`[adapter.search] LIKE → ${rows2.length} results`, terms);
    return rows2.map(r => ({ path: r.path }));
  }

  async bulkPrefetch(paths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!paths.length) return result;

    const ph   = paths.map(() => "?").join(",");
    const rows = this.query<{ path: string; content: string; chunk_index: number }>(
      `SELECT path, content, chunk_index FROM files WHERE path IN (${ph}) ORDER BY path, chunk_index`,
      paths,
    );

    const chunks = new Map<string, string[]>();
    for (const r of rows) {
      if (!chunks.has(r.path)) chunks.set(r.path, []);
      chunks.get(r.path)![r.chunk_index as number] = r.content;
    }
    for (const [p, parts] of chunks) result.set(p, parts.join(""));
    return result;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const size = new TextEncoder().encode(content).length;
    this.run(
      `INSERT OR REPLACE INTO files (path, chunk_index, content, size, mtime)
       VALUES (?, 0, ?, ?, datetime('now'))`,
      [path, content, size],
    );
  }

  async deleteFile(path: string): Promise<void> {
    this.run(`DELETE FROM files WHERE path = ?`, [path]);
  }

  getStats(): { fileCount: number; totalSize: number; chunkCount: number } {
    const r = this.queryOne<{ file_count: number; total_size: number; chunk_count: number }>(
      `SELECT COUNT(DISTINCT path) as file_count,
              COALESCE(SUM(size),0) as total_size,
              COUNT(*) as chunk_count
       FROM files`,
    );
    return {
      fileCount:  r?.file_count  ?? 0,
      totalSize:  r?.total_size  ?? 0,
      chunkCount: r?.chunk_count ?? 0,
    };
  }

  /** Export DB as Uint8Array — useful for persisting WASM DB to disk/IndexedDB */
  export(): Uint8Array {
    return this.db.export();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
