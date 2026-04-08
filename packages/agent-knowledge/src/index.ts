/**
 * @openfs/agent-knowledge
 *
 * Large-scale knowledge graph pipeline for OpenFS.
 * S3 bulk ingest → real vector embeddings (Chroma) → entity extraction → wiki synthesis.
 *
 * Usage:
 *   import { S3KnowledgePipeline, ChromaStore } from "@openfs/agent-knowledge";
 *
 *   const pipeline = new S3KnowledgePipeline({
 *     bucket: "my-docs",
 *     topic: "AI Infrastructure",
 *     chromaUrl: "http://localhost:8000",
 *   }, llm, agentWiki);
 *
 *   const result = await pipeline.run();
 *   // → { filesProcessed: 1247, chunksStored: 8900, entitiesExtracted: 340, ... }
 *
 *   const hits = await pipeline.search("how does auth work?");
 *   const { wikiPath } = await pipeline.expandTopic("authentication", { synthesize: true });
 */

export { S3KnowledgePipeline } from "./s3-pipeline.js";
export { ChromaStore } from "./chroma-store.js";
export { KnowledgeGraphBuilder } from "./kg-graph.js";
export { chunkDocument, stripHtml } from "./chunker.js";
export { extractText, extractXlsxSheets, renderSheetMarkdown, EXTRACTABLE_EXTENSIONS } from "./file-extractor.js";
export type { RawSheet } from "./file-extractor.js";

export type {
  Chunk,
  KgEntity,
  KgRelationship,
  KnowledgeGraph,
  SemanticResult,
  PipelineResult,
  S3PipelineOptions,
} from "./types.js";
