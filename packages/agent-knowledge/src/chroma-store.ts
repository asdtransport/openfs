/**
 * Chroma vector store for @openfs/agent-knowledge.
 * Uses OpenAI text-embedding-3-small via @chroma-core/openai (1536-dim, cosine).
 * Supports OpenRouter as an OpenAI-compatible embedding backend.
 * Requires OPENAI_API_KEY or OPENROUTER_API_KEY env var.
 */

import { ChromaClient } from "chromadb";
import { OpenAIEmbeddingFunction } from "@chroma-core/openai";
import type { Chunk, SemanticResult } from "./types.js";

export interface ChromaStoreOptions {
  collection?: string;
  chromaUrl?: string;
  openAiApiKey?: string;
}

/** Custom embedding function that calls OpenRouter (or any OpenAI-compatible endpoint) directly. */
function makeOpenRouterEmbedFn(apiKey: string): { generate: (texts: string[]) => Promise<number[][]> } {
  return {
    async generate(texts: string[]): Promise<number[][]> {
      console.log(`[chroma-store] OpenRouter embed: ${texts.length} text(s), key=...${apiKey.slice(-6)}`);
      const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": "https://openfs-production.up.railway.app",
          "X-Title": "OpenFS Knowledge Base",
        },
        body: JSON.stringify({ model: "openai/text-embedding-3-small", input: texts }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[chroma-store] OpenRouter embed FAILED (${res.status}): ${err}`);
        throw new Error(`OpenRouter embeddings failed (${res.status}): ${err}`);
      }
      const data = await res.json() as any;
      const vecs = data.data.map((d: any) => d.embedding);
      console.log(`[chroma-store] OpenRouter embed OK: ${vecs.length} vectors, dim=${vecs[0]?.length}`);
      return vecs;
    },
  };
}

export class ChromaStore {
  private client: ChromaClient;
  private collectionName: string;
  private collection: any = null;
  private embedFn: any;

  constructor(opts: ChromaStoreOptions = {}) {
    this.collectionName = opts.collection ?? "openfs-knowledge";
    const chromaUrl = opts.chromaUrl ?? "http://localhost:8000";
    this.client = new ChromaClient({ path: chromaUrl } as any);

    // Prefer OPENROUTER_API_KEY → explicit key → OPENAI_API_KEY
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    const openAiKey = opts.openAiApiKey || process.env.OPENAI_API_KEY;

    if (openRouterKey) {
      console.log(`[chroma-store] using OpenRouter embeddings (key=...${openRouterKey.slice(-6)})`);
      this.embedFn = makeOpenRouterEmbedFn(openRouterKey);
    } else if (openAiKey) {
      console.log(`[chroma-store] using OpenAI embeddings (key=...${openAiKey.slice(-6)})`);
      process.env.OPENAI_API_KEY = openAiKey;
      this.embedFn = new OpenAIEmbeddingFunction({ modelName: "text-embedding-3-small" });
    } else {
      console.warn(`[chroma-store] WARNING: no API key set — embeddings will fail`);
      this.embedFn = new OpenAIEmbeddingFunction({ modelName: "text-embedding-3-small" });
    }
  }

  async init(): Promise<void> {
    // Try getCollection first (GET request) to avoid triggering getOrCreateCollection
    // POST which causes _type KeyError on ChromaDB 0.6+ with JS client 3.x.
    // Fall back to getOrCreateCollection only if the collection doesn't exist yet.
    try {
      this.collection = await this.client.getCollection({
        name: this.collectionName,
        embeddingFunction: this.embedFn,
      });
    } catch {
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        embeddingFunction: this.embedFn,
        metadata: { "hnsw:space": "cosine" },
      });
    }
  }

  async upsertChunks(chunks: Chunk[]): Promise<void> {
    if (!this.collection) await this.init();
    if (chunks.length === 0) return;

    // Generate embeddings ourselves in controlled batches of 20.
    // Passing embeddings explicitly to collection.upsert() bypasses ChromaDB's
    // internal batching (which calls our fn with ~2 texts at a time, causing
    // partial failures under rate limits that leave stale vectors in place).
    const EMBED_BATCH = 20;
    const UPSERT_BATCH = 100;

    const allEmbeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const texts = chunks.slice(i, i + EMBED_BATCH).map((c: Chunk) => c.content);
      const vecs = await this.embedFn.generate(texts);
      allEmbeddings.push(...vecs);
    }

    for (let i = 0; i < chunks.length; i += UPSERT_BATCH) {
      const batch = chunks.slice(i, i + UPSERT_BATCH);
      await this.collection.upsert({
        ids: batch.map((c: Chunk) => c.id),
        documents: batch.map((c: Chunk) => c.content),
        embeddings: allEmbeddings.slice(i, i + UPSERT_BATCH),
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

    // Generate query embedding explicitly so we always use our client-side
    // embedding function (OpenRouter/OpenAI 1536-dim cosine), never the
    // server-side default (all-MiniLM-L6-v2 384-dim) that ChromaDB 1.5.x
    // may invoke when queryTexts is passed.
    const [queryEmbedding] = await this.embedFn.generate([query]);

    const results = await this.collection.query({
      queryEmbeddings: [queryEmbedding],
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

  /** Wipe all vectors by deleting every chunk ID — avoids collection delete/recreate API issues. */
  async reset(): Promise<void> {
    if (!this.collection) await this.init();
    try {
      const all = await this.collection.get({ include: [] as any });
      const ids: string[] = Array.isArray(all.ids) ? all.ids : [];
      if (ids.length > 0) {
        const BATCH = 500;
        for (let i = 0; i < ids.length; i += BATCH) {
          await this.collection.delete({ ids: ids.slice(i, i + BATCH) });
        }
        console.log(`[chroma-store] deleted ${ids.length} chunks from "${this.collectionName}"`);
      } else {
        console.log(`[chroma-store] collection "${this.collectionName}" already empty`);
      }
    } catch (e) {
      console.warn(`[chroma-store] reset failed, continuing anyway: ${e}`);
    }
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
