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
import type { AdapterOptions, OpenFsAdapter } from "./interface.js";
import { PathTree } from "./path-tree.js";
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
    writeFile(path: string, content: FileContent, options?: WriteFileOptions | string): Promise<void>;
    appendFile(path: string, content: FileContent, options?: WriteFileOptions | string): Promise<void>;
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
export declare function createOpenFs(adapter: OpenFsAdapter, options?: OpenFsOptions): IFileSystem;
/**
 * Initialize an OpenFS adapter and create the IFileSystem in one call.
 *
 * Convenience wrapper that calls adapter.init() and builds the path tree.
 */
export declare function initOpenFs(adapter: OpenFsAdapter, options?: OpenFsOptions): Promise<IFileSystem>;
export {};
//# sourceMappingURL=openfs.d.ts.map