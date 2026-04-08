/**
 * S3 → Chroma → KnowledgeGraph → AgentWiki pipeline.
 *
 * Orchestrates the full flow:
 *  1. List all objects in an S3 bucket (with optional prefix)
 *  2. Read each object's content
 *  3. Chunk with semantic boundary detection
 *  4. Embed + store in Chroma (real 384-dim vectors)
 *  5. Extract entities → build knowledge graph
 *  6. Synthesize wiki pages via agent-wiki
 *
 * Designed to scale to 1000s of files.
 * Each step is independent so partial runs can resume.
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { chunkDocument, stripHtml } from "./chunker.js";
import { ChromaStore } from "./chroma-store.js";
import { KnowledgeGraphBuilder } from "./kg-graph.js";
import { extractText, EXTRACTABLE_EXTENSIONS } from "./file-extractor.js";
import type {
  Chunk,
  KnowledgeGraph,
  PipelineResult,
  S3PipelineOptions,
} from "./types.js";

const SUPPORTED_EXTENSIONS = EXTRACTABLE_EXTENSIONS;

export class S3KnowledgePipeline {
  private s3: S3Client;
  private store: ChromaStore;
  private kgBuilder: KnowledgeGraphBuilder | null;

  constructor(
    private opts: S3PipelineOptions,
    llm?: { complete(sys: string, prompt: string, o?: { maxTokens?: number }): Promise<string> },
    // Optional: AgentWiki instance for wiki synthesis
    private agentWiki?: {
      ingest(title: string, content: string): Promise<{ pagesCreated: string[]; pagesUpdated: string[] }>;
      agentFs: { ingest(files: Record<string, string>): Promise<void> };
    },
  ) {
    this.s3 = new S3Client({
      region: opts.s3Region ?? "us-east-1",
      endpoint: opts.s3Endpoint,
      forcePathStyle: !!opts.s3Endpoint,
      credentials:
        opts.s3AccessKeyId && opts.s3SecretAccessKey
          ? { accessKeyId: opts.s3AccessKeyId, secretAccessKey: opts.s3SecretAccessKey }
          : undefined,
    });

    this.store = new ChromaStore({
      collection: opts.chromaCollection ?? "openfs-knowledge",
      chromaUrl: opts.chromaUrl ?? "http://localhost:8000",
    });

    this.kgBuilder = llm ? new KnowledgeGraphBuilder(llm) : null;
  }

  /**
   * Run the full pipeline. Returns a summary of what was processed.
   */
  async run(): Promise<PipelineResult> {
    await this.store.init();

    const result: PipelineResult = {
      filesProcessed: 0,
      chunksStored: 0,
      entitiesExtracted: 0,
      wikiPagesCreated: [],
      wikiPagesUpdated: [],
      errors: [],
    };

    // 1. List S3 objects
    const keys = await this.listObjects();
    const limit = this.opts.limit ?? keys.length;
    const toProcess = keys.slice(0, limit);

    let kg: KnowledgeGraph = {
      entities: [],
      relationships: [],
      clusters: {},
      builtAt: new Date().toISOString(),
    };

    // 2. Process each file
    for (let i = 0; i < toProcess.length; i++) {
      const key = toProcess[i];
      try {
        const { content, title } = await this.readS3Object(key);
        if (!content.trim()) continue;

        // 3. Chunk
        const chunks = chunkDocument(key, title, content, {
          chunkSize: this.opts.chunkSize ?? 1200,
          overlap: this.opts.chunkOverlap ?? 200,
        }).map(c => ({ ...c, topic: this.opts.topic }));

        // 4. Embed + store in Chroma
        await this.store.upsertChunks(chunks);
        result.chunksStored += chunks.length;
        result.filesProcessed++;

        this.opts.onProgress?.({
          file: key,
          chunks: chunks.length,
          done: i + 1,
          total: toProcess.length,
        });

        // 5. LLM entity extraction (if LLM provided)
        if (this.kgBuilder && chunks.length > 0) {
          const sample = chunks.slice(0, 4).map(c => ({
            source: c.source,
            title: c.title,
            content: c.content,
            score: 1,
          }));
          const { entities, relationships } = await this.kgBuilder.extractFromChunks(
            sample,
            this.opts.topic ?? title,
          );
          result.entitiesExtracted += entities.length;
          kg = this.kgBuilder.mergeGraph(kg, entities, relationships, this.opts.topic ?? title);
        }

        // 6. Wiki synthesis (if agent-wiki provided)
        if (this.agentWiki) {
          try {
            const wikiResult = await this.agentWiki.ingest(title, content.slice(0, 8000));
            result.wikiPagesCreated.push(...wikiResult.pagesCreated);
            result.wikiPagesUpdated.push(...wikiResult.pagesUpdated);
          } catch { /* non-fatal */ }
        }
      } catch (e) {
        result.errors.push(`${key}: ${(e as Error).message}`);
      }
    }

    // 7. Persist knowledge graph into OpenFS (if agent-wiki provided)
    if (this.kgBuilder && this.agentWiki && kg.entities.length > 0) {
      try {
        const kgFiles = this.kgBuilder.graphToFiles(kg);
        await this.agentWiki.agentFs.ingest(kgFiles);
      } catch { /* non-fatal */ }
    }

    return result;
  }

  /**
   * Semantic search across the embedded corpus.
   * Returns ranked results with source attribution.
   */
  async search(
    query: string,
    opts: { topK?: number; topic?: string; mode?: "semantic" | "text" } = {},
  ) {
    if (!this.store) await this.store.init();
    if (opts.mode === "text") {
      return this.store.textSearch(query, { topic: opts.topic });
    }
    return this.store.semanticSearch(query, { topK: opts.topK, topic: opts.topic });
  }

  /**
   * Expand a topic: semantic search → synthesis → wiki page.
   * The core "knowledge compounding" loop.
   */
  async expandTopic(
    topic: string,
    opts: { topK?: number; synthesize?: boolean } = {},
  ): Promise<{ results: Awaited<ReturnType<ChromaStore["semanticSearch"]>>; wikiPath?: string }> {
    await this.store.init();
    const results = await this.store.semanticSearch(topic, {
      topK: opts.topK ?? 20,
      topic: this.opts.topic,
    });

    let wikiPath: string | undefined;

    if (opts.synthesize && this.agentWiki && results.length > 0) {
      const combined = results
        .map(r => `# ${r.title}\n\n${r.content}`)
        .join("\n\n---\n\n")
        .slice(0, 12000);

      try {
        const wikiResult = await this.agentWiki.ingest(topic, combined);
        wikiPath = wikiResult.pagesCreated[0] ?? wikiResult.pagesUpdated[0];
      } catch { /* non-fatal */ }
    }

    return { results, wikiPath };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async listObjects(): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.opts.bucket,
          Prefix: this.opts.prefix,
          ContinuationToken: token,
        }),
      );

      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const ext = "." + obj.Key.split(".").pop()?.toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext) || !obj.Key.includes(".")) {
          keys.push(obj.Key);
        }
      }

      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    return keys;
  }

  private async readS3Object(key: string): Promise<{ content: string; title: string }> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
    );

    if (!res.Body) throw new Error(`Empty body for key: ${key}`);

    const filename    = key.split("/").pop() ?? key;
    const contentType = res.ContentType ?? "";

    // Read as bytes so binary formats (PDF/DOCX/XLSX) aren't mangled
    const bytes   = await res.Body.transformToByteArray();
    let content   = await extractText(bytes, filename, contentType);

    // Strip HTML tags after extraction
    if (key.endsWith(".html") || key.endsWith(".htm")) {
      content = stripHtml(content);
    }

    // Derive title: "docs/openfs/architecture.md" → "Architecture"
    const title = filename
      .replace(/\.[^.]+$/, "")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());

    return { content, title };
  }
}
