/**
 * @openfs/agent-knowledge — shared types
 */

/** A single chunk of a source document */
export interface Chunk {
  /** Unique ID: `${source}__chunk_${index}` */
  id: string;
  /** Source file path or URL */
  source: string;
  /** Original document title */
  title: string;
  /** Chunk text content */
  content: string;
  /** Position in original document */
  chunkIndex: number;
  /** Total chunks for this source */
  totalChunks: number;
  /** Optional topic/bucket tag */
  topic?: string;
}

/** An entity extracted from documents */
export interface KgEntity {
  id: string;
  /** Display name */
  name: string;
  /** person | organization | concept | technology | event | place */
  type: string;
  /** Source documents that mention this entity */
  sources: string[];
  /** Short description */
  description?: string;
}

/** A directed relationship between two entities */
export interface KgRelationship {
  fromId: string;
  toId: string;
  /** relates_to | depends_on | part_of | created_by | used_by | competes_with */
  type: string;
  /** Source document that established this relationship */
  source: string;
}

/** Knowledge graph: entities + relationships */
export interface KnowledgeGraph {
  entities: KgEntity[];
  relationships: KgRelationship[];
  /** Topic clusters: topic → entity IDs */
  clusters: Record<string, string[]>;
  builtAt: string;
}

/** Options for the S3 pipeline */
export interface S3PipelineOptions {
  /** S3 bucket name */
  bucket: string;
  /** Key prefix filter (e.g. "docs/") */
  prefix?: string;
  /** Chroma collection to store embeddings */
  chromaCollection?: string;
  /** Chroma server URL */
  chromaUrl?: string;
  /** S3 endpoint (for MinIO) */
  s3Endpoint?: string;
  s3Region?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  /** Chunk size in characters (default 1200) */
  chunkSize?: number;
  /** Chunk overlap in characters (default 200) */
  chunkOverlap?: number;
  /** Max files to process (default unlimited) */
  limit?: number;
  /** Topic tag applied to all ingested docs */
  topic?: string;
  /** Called after each file is processed */
  onProgress?: (info: { file: string; chunks: number; done: number; total: number }) => void;
}

/** Result of a semantic search */
export interface SemanticResult {
  source: string;
  title: string;
  content: string;
  score: number;
  topic?: string;
}

/** Result of the full pipeline run */
export interface PipelineResult {
  filesProcessed: number;
  chunksStored: number;
  entitiesExtracted: number;
  wikiPagesCreated: string[];
  wikiPagesUpdated: string[];
  errors: string[];
}
