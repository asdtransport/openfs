/**
 * @openfs/adapter-sqlite — uses Bun's built-in bun:sqlite (3-6x faster than better-sqlite3)
 */
import { Database } from "bun:sqlite";
import type { AdapterOptions, FileMeta, GrepFlags, OpenFsAdapter, PathTreeNode, SearchResult } from "@openfs/core";

export interface SqliteAdapterOptions {
  dbPath: string;
  walMode?: boolean;
}

export class SqliteAdapter implements OpenFsAdapter {
  readonly name = "sqlite";
  private db: Database;

  constructor(opts: SqliteAdapterOptions) {
    this.db = new Database(opts.dbPath);
    if (opts.walMode !== false) this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS files (
      path TEXT NOT NULL, chunk_index INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '', is_public INTEGER NOT NULL DEFAULT 1,
      groups_json TEXT NOT NULL DEFAULT '[]', size INTEGER NOT NULL DEFAULT 0,
      mtime TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (path, chunk_index)
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)`);
    try { this.db.run(`CREATE VIRTUAL TABLE files_fts USING fts5(path, content, content='files', content_rowid='rowid')`); } catch {}
    this.db.run(`CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN INSERT INTO files_fts(rowid,path,content) VALUES(new.rowid,new.path,new.content); END`);
    this.db.run(`CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN INSERT INTO files_fts(files_fts,rowid,path,content) VALUES('delete',old.rowid,old.path,old.content); END`);
    this.db.run(`CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN INSERT INTO files_fts(files_fts,rowid,path,content) VALUES('delete',old.rowid,old.path,old.content); INSERT INTO files_fts(rowid,path,content) VALUES(new.rowid,new.path,new.content); END`);
  }

  async init(_options?: AdapterOptions): Promise<Map<string, PathTreeNode>> {
    const rows = this.db.query(`SELECT DISTINCT path, is_public, groups_json FROM files ORDER BY path`).all() as Array<{ path: string; is_public: number; groups_json: string }>;
    const m = new Map<string, PathTreeNode>();
    for (const r of rows) m.set(r.path, { isPublic: r.is_public === 1, groups: JSON.parse(r.groups_json) });
    return m;
  }

  async readFile(path: string): Promise<string> {
    const rows = this.db.query(`SELECT content FROM files WHERE path = ? ORDER BY chunk_index ASC`).all(path) as Array<{ content: string }>;
    if (rows.length === 0) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return rows.map(r => r.content).join("");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> { return new TextEncoder().encode(await this.readFile(path)); }

  async getFileMeta(path: string): Promise<FileMeta> {
    const row = this.db.query(`SELECT path, is_public, groups_json, SUM(size) as total_size, MAX(mtime) as mtime, COUNT(*) as chunk_count FROM files WHERE path = ? GROUP BY path`).get(path) as any;
    if (!row) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return { path: row.path, isPublic: row.is_public === 1, groups: JSON.parse(row.groups_json), size: row.total_size, mtime: new Date(row.mtime), chunkCount: row.chunk_count };
  }

  async search(query: string, flags?: Partial<GrepFlags>): Promise<SearchResult[]> {
    const escaped = query.replace(/['"]/g, "").replace(/[*(){}[\]^~]/g, " ");
    const STOP = new Set(["a","an","the","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","shall","can","i","we","you","he","she","it","they","me","us","him","her","them","my","our","your","his","its","their","this","that","these","those","what","which","who","how","when","where","why","and","or","not","in","on","at","by","for","of","to","from","with","as","into","up","out","if","so","but"]);
    const ftsQuery = flags?.fixedStrings
      ? `"${escaped}"`
      : escaped.split(/\s+/).filter(w => w.length > 1 && !STOP.has(w.toLowerCase())).map(w => `"${w}"`).join(" ");
    if (!ftsQuery.trim()) return [];
    try {
      return (this.db.query(`SELECT DISTINCT path FROM files_fts WHERE files_fts MATCH ? ORDER BY rank LIMIT 500`).all(ftsQuery) as Array<{ path: string }>).map(r => ({ path: r.path }));
    } catch {
      return (this.db.query(`SELECT DISTINCT path FROM files WHERE content LIKE ? LIMIT 500`).all(`%${escaped}%`) as Array<{ path: string }>).map(r => ({ path: r.path }));
    }
  }

  async bulkPrefetch(paths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!paths.length) return result;
    const ph = paths.map(() => "?").join(",");
    const rows = this.db.query(`SELECT path, content, chunk_index FROM files WHERE path IN (${ph}) ORDER BY path, chunk_index`).all(...paths) as Array<{ path: string; content: string; chunk_index: number }>;
    const chunks = new Map<string, string[]>();
    for (const r of rows) { if (!chunks.has(r.path)) chunks.set(r.path, []); chunks.get(r.path)![r.chunk_index] = r.content; }
    for (const [p, parts] of chunks) result.set(p, parts.join(""));
    return result;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.db.query(`INSERT OR REPLACE INTO files (path, chunk_index, content, size, mtime) VALUES (?, 0, ?, ?, datetime('now'))`).run(path, content, new TextEncoder().encode(content).length);
  }

  writeFileChunked(path: string, chunks: string[], meta?: { isPublic?: boolean; groups?: string[] }): void {
    const tx = this.db.transaction(() => {
      this.db.query(`DELETE FROM files WHERE path = ?`).run(path);
      const ins = this.db.query(`INSERT INTO files (path, chunk_index, content, size, is_public, groups_json, mtime) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`);
      for (let i = 0; i < chunks.length; i++) ins.run(path, i, chunks[i], new TextEncoder().encode(chunks[i]).length, meta?.isPublic !== false ? 1 : 0, JSON.stringify(meta?.groups ?? []));
    });
    tx();
  }

  ingestDirectory(files: Record<string, string>, meta?: { isPublic?: boolean; groups?: string[] }): void {
    const tx = this.db.transaction(() => {
      const ins = this.db.query(`INSERT OR REPLACE INTO files (path, chunk_index, content, size, is_public, groups_json, mtime) VALUES (?, 0, ?, ?, ?, ?, datetime('now'))`);
      for (const [p, c] of Object.entries(files)) ins.run(p, c, new TextEncoder().encode(c).length, meta?.isPublic !== false ? 1 : 0, JSON.stringify(meta?.groups ?? []));
    });
    tx();
  }

  async deleteFile(path: string): Promise<void> { this.db.query(`DELETE FROM files WHERE path = ?`).run(path); }

  getStats(): { fileCount: number; totalSize: number; chunkCount: number } {
    const r = this.db.query(`SELECT COUNT(DISTINCT path) as file_count, COALESCE(SUM(size),0) as total_size, COUNT(*) as chunk_count FROM files`).get() as any;
    return { fileCount: r.file_count, totalSize: r.total_size, chunkCount: r.chunk_count };
  }

  /** Raw SELECT — returns rows as plain objects (compatible with AgentFs.query) */
  query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    return this.db.query(sql).all(...params) as Record<string, unknown>[];
  }

  /** Raw DML/DDL statement (compatible with AgentFs.run) */
  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, ...params);
  }

  /** No-op export — server-side persistence is the .db file itself */
  export(): Uint8Array {
    return new Uint8Array(0);
  }

  async close(): Promise<void> { this.db.close(); }
}
