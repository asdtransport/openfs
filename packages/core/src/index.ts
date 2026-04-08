/**
 * @openfs/core
 *
 * Pluggable virtual filesystem framework for just-bash.
 */

// Adapter interface
export type {
  OpenFsAdapter,
  AdapterOptions,
  CacheBackend,
  FileMeta,
  GrepFlags,
  PathTreeNode,
  SearchResult,
} from "./interface.js";

// Core filesystem factory
export { createOpenFs, initOpenFs } from "./openfs.js";
export type { IFileSystem, OpenFsOptions } from "./openfs.js";

// Utilities
export { PathTree } from "./path-tree.js";
export { InMemoryCache } from "./cache.js";
