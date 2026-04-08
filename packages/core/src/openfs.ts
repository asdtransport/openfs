/**
 * @openfs/core - createOpenFs
 *
 * Wraps any OpenFsAdapter into a just-bash IFileSystem.
 * This is the bridge between the adapter interface and just-bash's contract.
 *
 * Handles:
 * - Full IFileSystem compliance (all 20+ methods)
 * - Path tree for directory operations (zero network)
 * - Read caching (LRU)
 * - EROFS enforcement for read-only adapters
 * - Lazy file resolution
 */

import { InMemoryCache } from "./cache.js";
import type {
  AdapterOptions,
  CacheBackend,
  OpenFsAdapter,
} from "./interface.js";
import { PathTree } from "./path-tree.js";

// --- Types mirrored from just-bash IFileSystem ---
// We re-declare them here so @openfs/core has zero hard dependency on just-bash.
// The shapes are structurally compatible (duck typing).

interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface ReadFileOptions {
  encoding?: string | null;
}

interface WriteFileOptions {
  encoding?: string;
}

interface MkdirOptions {
  recursive?: boolean;
}

interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

interface CpOptions {
  recursive?: boolean;
}

type FileContent = string | Uint8Array;

/**
 * IFileSystem shape — structurally matches just-bash's interface
 * without requiring it as a compile-time dependency.
 */
export interface IFileSystem {
  readFile(path: string, options?: ReadFileOptions | string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | string,
  ): Promise<void>;
  appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | string,
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FsStat>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;
  rm(path: string, options?: RmOptions): Promise<void>;
  cp(src: string, dest: string, options?: CpOptions): Promise<void>;
  mv(src: string, dest: string): Promise<void>;
  resolvePath(base: string, path: string): string;
  getAllPaths(): string[];
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  lstat(path: string): Promise<FsStat>;
  realpath(path: string): Promise<string>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

// --- Helpers ---

function normalizePath(path: string): string {
  if (!path || path === "/") return "/";
  let p = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  if (!p.startsWith("/")) p = `/${p}`;
  const parts = p.split("/").filter((s) => s && s !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join("/")}` || "/";
}

function dirname(path: string): string {
  const p = normalizePath(path);
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

function joinPath(base: string, rel: string): string {
  if (rel.startsWith("/")) return normalizePath(rel);
  return normalizePath(`${base}/${rel}`);
}

function erofs(op: string, path: string): never {
  throw new Error(`EROFS: read-only file system, ${op} '${path}'`);
}

function enoent(op: string, path: string): never {
  throw new Error(`ENOENT: no such file or directory, ${op} '${path}'`);
}

function enotdir(op: string, path: string): never {
  throw new Error(`ENOTDIR: not a directory, ${op} '${path}'`);
}

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

// --- The main factory ---

export interface OpenFsOptions extends AdapterOptions {
  /** Pre-built PathTree (for testing or sharing across instances) */
  pathTree?: PathTree;
}

/**
 * Create a just-bash compatible IFileSystem backed by any OpenFsAdapter.
 *
 * Usage:
 * ```ts
 * const adapter = new SqliteAdapter({ dbPath: "./docs.db" });
 * await adapter.init();
 * const fs = createOpenFs(adapter, { userGroups: ["admin"] });
 * const bash = new Bash({ fs });
 * ```
 */
export function createOpenFs(
  adapter: OpenFsAdapter,
  options: OpenFsOptions = {},
): IFileSystem {
  const tree = options.pathTree ?? new PathTree();
  const cache: CacheBackend = options.cache ?? new InMemoryCache(2000);
  const writable = options.writable ?? false;
  const lazyPointers = options.lazyPointers ?? {};

  // Track if init has been called — if pathTree was pre-built, we're ready
  let initialized = !!options.pathTree;

  /** Ensure the adapter has been initialized */
  function assertInit(): void {
    if (!initialized) {
      throw new Error(
        "OpenFS not initialized. Call adapter.init() before using the filesystem.",
      );
    }
  }

  /** Read file with caching */
  async function cachedRead(path: string): Promise<string> {
    const cached = await cache.get(`file:${path}`);
    if (cached !== null) return cached;

    // Check lazy pointers first
    if (path in lazyPointers) {
      const content = await lazyPointers[path]();
      await cache.set(`file:${path}`, content);
      return content;
    }

    const content = await adapter.readFile(path);
    await cache.set(`file:${path}`, content);
    return content;
  }

  const fs: IFileSystem = {
    async readFile(
      path: string,
      _options?: ReadFileOptions | string,
    ): Promise<string> {
      assertInit();
      const p = normalizePath(path);
      if (!tree.exists(p)) enoent("open", p);
      if (tree.isDirectory(p)) {
        throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
      }
      return cachedRead(p);
    },

    async readFileBuffer(path: string): Promise<Uint8Array> {
      assertInit();
      const p = normalizePath(path);
      if (!tree.exists(p)) enoent("open", p);
      if (tree.isDirectory(p)) {
        throw new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
      }
      // Try adapter's native buffer read, fall back to text encoding
      try {
        return await adapter.readFileBuffer(p);
      } catch {
        const text = await cachedRead(p);
        return new TextEncoder().encode(text);
      }
    },

    async writeFile(
      path: string,
      content: FileContent,
      _options?: WriteFileOptions | string,
    ): Promise<void> {
      if (!writable) erofs("write", path);
      assertInit();
      const p = normalizePath(path);
      if (adapter.writeFile) {
        const text =
          typeof content === "string"
            ? content
            : new TextDecoder().decode(content);
        await adapter.writeFile(p, text);
        await cache.del(`file:${p}`);
      }
    },

    async appendFile(
      path: string,
      content: FileContent,
      _options?: WriteFileOptions | string,
    ): Promise<void> {
      if (!writable) erofs("append", path);
      assertInit();
      const p = normalizePath(path);
      const existing = tree.isFile(p) ? await cachedRead(p) : "";
      const appendText =
        typeof content === "string"
          ? content
          : new TextDecoder().decode(content);
      if (adapter.writeFile) {
        await adapter.writeFile(p, existing + appendText);
        await cache.del(`file:${p}`);
      }
    },

    async exists(path: string): Promise<boolean> {
      assertInit();
      return tree.exists(normalizePath(path));
    },

    async stat(path: string): Promise<FsStat> {
      assertInit();
      const p = normalizePath(path);
      if (!tree.exists(p)) enoent("stat", p);

      if (tree.isDirectory(p)) {
        return {
          isFile: false,
          isDirectory: true,
          isSymbolicLink: false,
          mode: DEFAULT_DIR_MODE,
          size: 4096,
          mtime: new Date(),
        };
      }

      // File - get metadata from adapter
      try {
        const meta = await adapter.getFileMeta(p);
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: DEFAULT_FILE_MODE,
          size: meta.size,
          mtime: meta.mtime,
        };
      } catch {
        // Fallback: read the file to get size
        const content = await cachedRead(p);
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: DEFAULT_FILE_MODE,
          size: new TextEncoder().encode(content).length,
          mtime: new Date(),
        };
      }
    },

    async mkdir(path: string, _options?: MkdirOptions): Promise<void> {
      if (!writable) erofs("mkdir", path);
      // In read-only mode we never get here. In writable mode, this is a no-op
      // since the path tree is managed by the adapter.
    },

    async readdir(path: string): Promise<string[]> {
      assertInit();
      const p = normalizePath(path);
      if (!tree.exists(p)) enoent("scandir", p);
      if (!tree.isDirectory(p)) enotdir("scandir", p);
      return tree.readdir(p);
    },

    async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
      assertInit();
      const p = normalizePath(path);
      if (!tree.exists(p)) enoent("scandir", p);
      if (!tree.isDirectory(p)) enotdir("scandir", p);

      const names = tree.readdir(p);
      return names.map((name) => {
        const childPath = p === "/" ? `/${name}` : `${p}/${name}`;
        return {
          name,
          isFile: tree.isFile(childPath),
          isDirectory: tree.isDirectory(childPath),
          isSymbolicLink: false,
        };
      });
    },

    async rm(path: string, options?: RmOptions): Promise<void> {
      if (!writable) erofs("rm", path);
      assertInit();
      const p = normalizePath(path);
      if (!tree.exists(p) && !options?.force) enoent("rm", p);
      if (adapter.deleteFile) await adapter.deleteFile(p);
    },

    async cp(src: string, dest: string, _options?: CpOptions): Promise<void> {
      if (!writable) erofs("cp", dest);
      assertInit();
      const s = normalizePath(src);
      if (!tree.exists(s)) enoent("cp", s);
      const content = await cachedRead(s);
      if (adapter.writeFile) await adapter.writeFile(normalizePath(dest), content);
    },

    async mv(src: string, dest: string): Promise<void> {
      if (!writable) erofs("rename", dest);
      assertInit();
      const s = normalizePath(src);
      if (!tree.exists(s)) enoent("rename", s);
      const content = await cachedRead(s);
      if (adapter.writeFile) await adapter.writeFile(normalizePath(dest), content);
      if (adapter.deleteFile) await adapter.deleteFile(s);
    },

    resolvePath(base: string, path: string): string {
      return joinPath(base, path);
    },

    getAllPaths(): string[] {
      return [...tree.getAllPaths(), ...tree.getAllDirs()];
    },

    async chmod(_path: string, _mode: number): Promise<void> {
      // No-op: virtual filesystem doesn't track real permissions
    },

    async symlink(_target: string, linkPath: string): Promise<void> {
      if (!writable) erofs("symlink", linkPath);
      // Symlinks not supported in virtual FS
      throw new Error(`ENOSYS: function not implemented, symlink '${linkPath}'`);
    },

    async link(_existingPath: string, newPath: string): Promise<void> {
      if (!writable) erofs("link", newPath);
      throw new Error(`ENOSYS: function not implemented, link '${newPath}'`);
    },

    async readlink(path: string): Promise<string> {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    },

    async lstat(path: string): Promise<FsStat> {
      // No symlinks in virtual FS, so lstat === stat
      return fs.stat(path);
    },

    async realpath(path: string): Promise<string> {
      assertInit();
      const p = normalizePath(path);
      if (!tree.exists(p)) enoent("realpath", p);
      return p;
    },

    async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
      // No-op
    },
  };

  return fs;
}

/**
 * Initialize an OpenFS adapter and create the IFileSystem in one call.
 *
 * Convenience wrapper that calls adapter.init() and builds the path tree.
 */
export async function initOpenFs(
  adapter: OpenFsAdapter,
  options: OpenFsOptions = {},
): Promise<IFileSystem> {
  const pathMap = await adapter.init(options);
  const tree = new PathTree();
  tree.build(pathMap, options.userGroups);

  return createOpenFs(adapter, { ...options, pathTree: tree });
}
