import type { OpenFsAdapter, PathTreeNode, AdapterOptions, FileMeta, GrepFlags, SearchResult } from "@openfs/core";
export class PostgresAdapter implements OpenFsAdapter {
  readonly name = "postgres";
  async init(_o?: AdapterOptions): Promise<Map<string, PathTreeNode>> { throw new Error("Not implemented — community contribution welcome!"); }
  async readFile(_p: string): Promise<string> { throw new Error("Not implemented"); }
  async readFileBuffer(_p: string): Promise<Uint8Array> { throw new Error("Not implemented"); }
  async getFileMeta(_p: string): Promise<FileMeta> { throw new Error("Not implemented"); }
  async search(_q: string, _f?: Partial<GrepFlags>): Promise<SearchResult[]> { throw new Error("Not implemented"); }
  async bulkPrefetch(_p: string[]): Promise<Map<string, string>> { throw new Error("Not implemented"); }
  async close(): Promise<void> {}
}
