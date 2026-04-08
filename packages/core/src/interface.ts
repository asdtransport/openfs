/**
 * @openfs/core - Adapter Interface
 *
 * Every OpenFS adapter (SQLite, MySQL, Chroma, S3, etc.) implements this interface.
 * The core framework wraps it into a just-bash IFileSystem.
 */

/**
 * Grep flags parsed from command line
 */
export interface GrepFlags {
  /** Case insensitive (-i) */
  ignoreCase?: boolean;
  /** Recursive (-r / -R) */
  recursive?: boolean;
  /** Fixed string match (-F) */
  fixedStrings?: boolean;
  /** Extended regex (-E) */
  extendedRegex?: boolean;
  /** Invert match (-v) */
  invertMatch?: boolean;
  /** Word match (-w) */
  wordRegex?: boolean;
  /** Line match (-x) */
  lineRegex?: boolean;
  /** Max count per file (-m) */
  maxCount?: number;
  /** The search pattern */
  pattern: string;
  /** Target paths */
  paths: string[];
}

/**
 * Result of a coarse search operation
 */
export interface SearchResult {
  /** File path that matched */
  path: string;
  /** Optional: matched chunk indices for partial fetch */
  chunkIndices?: number[];
}

/**
 * File metadata stored in the backing store
 */
export interface FileMeta {
  path: string;
  isPublic: boolean;
  groups: string[];
  size: number;
  mtime: Date;
  chunkCount: number;
}

/**
 * Path tree node for directory structure
 */
export interface PathTreeNode {
  isPublic: boolean;
  groups: string[];
}

/**
 * Cache backend interface (in-memory default, Redis optional)
 */
export interface CacheBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * Configuration options for any OpenFS adapter
 */
export interface AdapterOptions {
  /** User groups for RBAC path pruning */
  userGroups?: string[];
  /** Cache backend (defaults to in-memory LRU) */
  cache?: CacheBackend;
  /** Lazy file pointers - resolve on first access */
  lazyPointers?: Record<string, () => Promise<string>>;
  /** Whether writes are allowed (default: false = EROFS) */
  writable?: boolean;
  /** Default file extension to append (e.g., '.mdx') */
  defaultExtension?: string;
}

/**
 * The adapter interface all backing stores implement.
 *
 * Adapters handle data access. The core framework handles:
 * - IFileSystem compliance
 * - Path tree management
 * - Caching
 * - RBAC enforcement
 * - Write protection (EROFS)
 */
export interface OpenFsAdapter {
  /** Adapter name for logging/identification */
  readonly name: string;

  /**
   * Initialize the adapter and return the path tree.
   * This is called once at startup.
   */
  init(options?: AdapterOptions): Promise<Map<string, PathTreeNode>>;

  /**
   * Read file content. If the file is chunked, reassemble from chunks.
   * @returns Full file content as string
   * @throws ENOENT if file doesn't exist
   */
  readFile(path: string): Promise<string>;

  /**
   * Read file content as binary.
   * @returns File content as Uint8Array
   * @throws ENOENT if file doesn't exist
   */
  readFileBuffer(path: string): Promise<Uint8Array>;

  /**
   * Get metadata for a file.
   * @throws ENOENT if file doesn't exist
   */
  getFileMeta(path: string): Promise<FileMeta>;

  /**
   * Coarse search: find files that MIGHT match a grep pattern.
   * This uses the backing store's native search (FTS5, FULLTEXT, $contains, etc.)
   * Results are then fine-filtered in-memory by just-bash.
   */
  search(query: string, flags?: Partial<GrepFlags>): Promise<SearchResult[]>;

  /**
   * Bulk prefetch file contents into cache.
   * Called before grep fine-filtering to minimize round trips.
   */
  bulkPrefetch(paths: string[]): Promise<Map<string, string>>;

  /**
   * Write file content (only if adapter supports writes).
   * @throws EROFS if read-only
   */
  writeFile?(path: string, content: string): Promise<void>;

  /**
   * Delete a file (only if adapter supports writes).
   * @throws EROFS if read-only
   */
  deleteFile?(path: string): Promise<void>;

  /**
   * Close/cleanup adapter resources.
   */
  close(): Promise<void>;
}
