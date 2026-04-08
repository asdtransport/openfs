/**
 * @openfs/adapter-chroma
 *
 * Chroma vector DB adapter for OpenFS.
 * Mirrors Mintlify's ChromaFs pattern:
 *   - __path_tree__ document stores gzipped directory tree
 *   - Pages reassembled from chunks sorted by chunk_index
 *   - $contains / where filters for coarse grep
 *   - Read-only by default (EROFS on writes)
 *
 * Requires a running Chroma server: chroma run --path ./chroma_data
 * Or use chromadb pip/bun package which includes the CLI.
 *
 * Usage:
 *   import { ChromaAdapter } from "@openfs/adapter-chroma";
 *   const adapter = new ChromaAdapter({
 *     collectionName: "docs",
 *     chromaUrl: "http://localhost:8000",
 *   });
 */

import { ChromaClient } from "chromadb";
import type {
  AdapterOptions,
  FileMeta,
  GrepFlags,
  OpenFsAdapter,
  PathTreeNode,
  SearchResult,
} from "@openfs/core";

/**
 * No-op embedding function for document-only storage.
 * OpenFS uses Chroma's $contains filter for text search,
 * not vector similarity, so real embeddings are unnecessary.
 */
class NoOpEmbeddingFunction {
  async generate(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0]);
  }
}

export interface ChromaAdapterOptions {
  /** Chroma collection name */
  collectionName: string;
  /** Chroma server URL (default: http://localhost:8000) */
  chromaUrl?: string;
  /** Tenant (default: default_tenant) */
  tenant?: string;
  /** Database (default: default_database) */
  database?: string;
}

export class ChromaAdapter implements OpenFsAdapter {
  readonly name = "chroma";
  private client: ChromaClient;
  private collectionName: string;
  private collection: any = null;

  private embeddingFunction = new NoOpEmbeddingFunction();

  constructor(opts: ChromaAdapterOptions) {
    this.collectionName = opts.collectionName;
    const url = new URL(opts.chromaUrl ?? "http://localhost:8000");
    this.client = new ChromaClient({
      host: url.hostname,
      port: parseInt(url.port, 10) || 8000,
    });
  }

  async init(_options?: AdapterOptions): Promise<Map<string, PathTreeNode>> {
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      embeddingFunction: this.embeddingFunction,
    });

    // Try to load __path_tree__ document (Mintlify pattern)
    const pathMap = new Map<string, PathTreeNode>();

    try {
      const treeResult = await this.collection.get({
        ids: ["__path_tree__"],
      });

      if (treeResult.documents && treeResult.documents[0]) {
        const treeData = JSON.parse(treeResult.documents[0] as string) as Record<
          string,
          { isPublic?: boolean; groups?: string[] }
        >;

        for (const [path, meta] of Object.entries(treeData)) {
          pathMap.set(path.startsWith("/") ? path : `/${path}`, {
            isPublic: meta.isPublic !== false,
            groups: meta.groups ?? [],
          });
        }
        return pathMap;
      }
    } catch {
      // No __path_tree__ — fall back to scanning all documents
    }

    // Fallback: scan all documents for unique page paths
    const allDocs = await this.collection.get({});
    if (allDocs.metadatas) {
      const seen = new Set<string>();
      for (const meta of allDocs.metadatas) {
        if (meta && typeof meta === "object" && "page" in meta) {
          const page = String((meta as any).page);
          const path = page.startsWith("/") ? page : `/${page}`;
          if (!seen.has(path)) {
            seen.add(path);
            pathMap.set(path, {
              isPublic: (meta as any).isPublic !== false,
              groups: (meta as any).groups ?? [],
            });
          }
        }
      }
    }

    return pathMap;
  }

  async readFile(path: string): Promise<string> {
    // Fetch all chunks for this page, sorted by chunk_index
    const results = await this.collection.get({
      where: { page: path.startsWith("/") ? path.slice(1) : path },
    });

    if (!results.documents || results.documents.length === 0) {
      // Try with leading slash
      const results2 = await this.collection.get({
        where: { page: path },
      });
      if (!results2.documents || results2.documents.length === 0) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return this.reassembleChunks(results2);
    }

    return this.reassembleChunks(results);
  }

  private reassembleChunks(results: any): string {
    // Sort by chunk_index metadata and join
    const indexed: Array<{ index: number; content: string }> = [];

    for (let i = 0; i < results.documents.length; i++) {
      const doc = results.documents[i];
      const meta = results.metadatas?.[i];
      const chunkIndex =
        meta && typeof meta === "object" && "chunk_index" in meta
          ? Number((meta as any).chunk_index)
          : i;
      indexed.push({ index: chunkIndex, content: String(doc ?? "") });
    }

    indexed.sort((a, b) => a.index - b.index);
    return indexed.map((c) => c.content).join("");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path));
  }

  async getFileMeta(path: string): Promise<FileMeta> {
    const content = await this.readFile(path);
    return {
      path,
      isPublic: true,
      groups: [],
      size: new TextEncoder().encode(content).length,
      mtime: new Date(),
      chunkCount: 1,
    };
  }

  async search(
    query: string,
    _flags?: Partial<GrepFlags>,
  ): Promise<SearchResult[]> {
    // Use Chroma's $contains where filter for coarse matching
    try {
      const results = await this.collection.get({
        where_document: { $contains: query },
      });

      if (!results.metadatas) return [];

      const seen = new Set<string>();
      const matches: SearchResult[] = [];

      for (const meta of results.metadatas) {
        if (meta && typeof meta === "object" && "page" in meta) {
          const page = String((meta as any).page);
          const path = page.startsWith("/") ? page : `/${page}`;
          if (!seen.has(path)) {
            seen.add(path);
            matches.push({ path });
          }
        }
      }

      return matches;
    } catch {
      return [];
    }
  }

  async bulkPrefetch(paths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    // Fetch each path (Chroma doesn't support IN queries on metadata)
    for (const path of paths) {
      try {
        const content = await this.readFile(path);
        result.set(path, content);
      } catch {
        // Skip missing files
      }
    }
    return result;
  }

  /**
   * Ingest documents into Chroma collection.
   * Also creates the __path_tree__ document.
   */
  async ingestDocuments(
    files: Record<string, string>,
    meta?: { isPublic?: boolean; groups?: string[] },
  ): Promise<void> {
    // Ensure collection is initialized
    if (!this.collection) {
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        embeddingFunction: this.embeddingFunction,
      });
    }

    const ids: string[] = [];
    const documents: string[] = [];
    const metadatas: Array<Record<string, any>> = [];

    const pathTree: Record<string, { isPublic: boolean; groups: string[] }> = {};

    for (const [path, content] of Object.entries(files)) {
      const slug = path.startsWith("/") ? path.slice(1) : path;
      ids.push(`${slug}__chunk_0`);
      documents.push(content);
      metadatas.push({
        page: slug,
        chunk_index: 0,
        isPublic: meta?.isPublic !== false,
        groups: JSON.stringify(meta?.groups ?? []),
      });
      pathTree[path] = {
        isPublic: meta?.isPublic !== false,
        groups: meta?.groups ?? [],
      };
    }

    // Upsert all documents
    await this.collection.upsert({ ids, documents, metadatas });

    // Upsert __path_tree__
    await this.collection.upsert({
      ids: ["__path_tree__"],
      documents: [JSON.stringify(pathTree)],
      metadatas: [{ type: "path_tree" }],
    });
  }

  async close(): Promise<void> {
    // ChromaClient doesn't need explicit close
  }
}
