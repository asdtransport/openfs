/**
 * Chroma vector store for @openfs/agent-knowledge.
 * Uses OpenAI text-embedding-3-small via @chroma-core/openai (1536-dim, cosine).
 * Requires OPENAI_API_KEY env var.
 */

import { ChromaClient } from "chromadb";
import { OpenAIEmbeddingFunction } from "@chroma-core/openai";
import type { Chunk, SemanticResult } from "./types.js";

export interface ChromaStoreOptions {
  collection?: string;
  chromaUrl?: string;
  openAiApiKey?: string;
}

export class ChromaStore {
  private client: ChromaClient;
  private collectionName: string;
  private collection: any = null;
  private embedFn: OpenAIEmbeddingFunction;

  constructor(opts: ChromaStoreOptions = {}) {
    this.collectionName = opts.collection ?? "openfs-knowledge";
    const url = new URL(opts.chromaUrl ?? "http://localhost:8000");
    this.client = new ChromaClient({
      host: url.hostname,
      port: parseInt(url.port, 10) || 8000,
    });
    if (opts.openAiApiKey) {
      process.env.OPENAI_API_KEY = opts.openAiApiKey;
    }
    this.embedFn = new OpenAIEmbeddingFunction({
      modelName: "text-embedding-3-small",
    });
  }

  async init(): Promise<void> {
    this.collection = await this.client.getOrCreateCollection({
      name: this.collectionName,
      embeddingFunction: this.embedFn,
      metadata: { "hnsw:space": "cosine" },
    });
  }

  async upsertChunks(chunks: Chunk[]): Promise<void> {
    if (!this.collection) await this.init();
    if (chunks.length === 0) return;

    const BATCH = 100;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      await this.collection.upsert({
        ids: batch.map((c: Chunk) => c.id),
        documents: batch.map((c: Chunk) => c.content),
        metadatas: batch.map((c: Chunk) => ({
          source: c.source,
          title: c.title,
          chunkIndex: c.chunkIndex,
          totalChunks: c.totalChunks,
          topic: c.topic ?? "",
        })),
      });
    }
  }

  async semanticSearch(
    query: string,
    opts: { topK?: number; topic?: string; minScore?: number } = {},
  ): Promise<SemanticResult[]> {
    if (!this.collection) await this.init();

    const topK = opts.topK ?? 10;
    const where = opts.topic ? { topic: opts.topic } : undefined;

    const results = await this.collection.query({
      queryTexts: [query],
      nResults: topK,
      where,
    });

    const docs = results.documents?.[0] ?? [];
    const metas = results.metadatas?.[0] ?? [];
    const distances = results.distances?.[0] ?? [];

    return docs
      .map((doc: any, i: number) => {
        const score = 1 - (distances[i] ?? 1);
        if (opts.minScore != null && score < opts.minScore) return null;
        const meta = metas[i] as any;
        return {
          source: meta?.source ?? "",
          title: meta?.title ?? "",
          content: String(doc ?? ""),
          score,
          topic: meta?.topic || undefined,
        } as SemanticResult;
      })
      .filter(Boolean) as SemanticResult[];
  }

  async textSearch(query: string, opts: { topic?: string } = {}): Promise<SemanticResult[]> {
    if (!this.collection) await this.init();

    const where = opts.topic ? { topic: opts.topic } : undefined;
    const results = await this.collection.get({
      where_document: { $contains: query },
      where,
      limit: 50,
    });

    const seen = new Set<string>();
    return (results.documents ?? [])
      .map((doc: any, i: number) => {
        const meta = results.metadatas?.[i] as any;
        const src = meta?.source ?? "";
        if (seen.has(src)) return null;
        seen.add(src);
        return {
          source: src,
          title: meta?.title ?? "",
          content: String(doc ?? ""),
          score: 1,
          topic: meta?.topic || undefined,
        } as SemanticResult;
      })
      .filter(Boolean) as SemanticResult[];
  }

  async listSources(topic?: string): Promise<string[]> {
    if (!this.collection) await this.init();
    const where = topic ? { topic } : undefined;
    const all = await this.collection.get({ where, limit: 10000, include: ["metadatas"] });
    const seen = new Set<string>();
    for (const meta of (Array.isArray(all.metadatas) ? all.metadatas : [])) {
      if (meta && typeof meta === "object" && "source" in meta) {
        seen.add(String((meta as any).source));
      }
    }
    return [...seen];
  }

  async count(): Promise<number> {
    if (!this.collection) await this.init();
    return await this.collection.count();
  }

  /** List all collections with their chunk counts. */
  async listCollections(): Promise<Array<{ name: string; count: number }>> {
    const cols = await this.client.listCollections({ limit: 100, offset: 0 });
    const results: Array<{ name: string; count: number }> = [];
    for (const col of cols) {
      try {
        const c = await this.client.getCollection({ name: col.name, embeddingFunction: this.embedFn });
        results.push({ name: col.name, count: await c.count() });
      } catch {
        results.push({ name: col.name, count: 0 });
      }
    }
    return results;
  }

  /** Paginated chunk listing with optional metadata filters. */
  async listChunks(opts: {
    limit?: number;
    offset?: number;
    topic?: string;
    source?: string;
  } = {}): Promise<{ total: number; ids: string[]; documents: string[]; metadatas: any[] }> {
    if (!this.collection) await this.init();

    const where: any = {};
    if (opts.topic)  where.topic  = { $eq: opts.topic };
    if (opts.source) where.source = { $eq: opts.source };
    const hasWhere = Object.keys(where).length > 0;

    const result = await this.collection.get({
      where:   hasWhere ? where : undefined,
      limit:   opts.limit  ?? 50,
      offset:  opts.offset ?? 0,
      include: ["documents", "metadatas"],
    });

    const total = await this.collection.count();
    return {
      total,
      ids:       Array.isArray(result.ids)       ? result.ids       : [],
      documents: Array.isArray(result.documents) ? result.documents : [],
      metadatas: Array.isArray(result.metadatas) ? result.metadatas : [],
    };
  }

  /** Return distinct topic values across the collection. */
  async listTopics(): Promise<string[]> {
    if (!this.collection) await this.init();
    const all = await this.collection.get({ limit: 10000, include: ["metadatas"] });
    const seen = new Set<string>();
    for (const meta of (Array.isArray(all.metadatas) ? all.metadatas : [])) {
      const t = (meta as any)?.topic;
      if (t) seen.add(String(t));
    }
    return [...seen].sort();
  }

  /** Delete a single chunk by its Chroma ID. */
  async deleteChunk(id: string): Promise<void> {
    if (!this.collection) await this.init();
    await this.collection.delete({ ids: [id] });
  }

  /** Delete all chunks whose metadata.source equals the given path. */
  async deleteSource(sourcePath: string): Promise<void> {
    if (!this.collection) await this.init();
    await this.collection.delete({ where: { source: { $eq: sourcePath } } });
  }
}
