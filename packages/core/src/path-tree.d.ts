/**
 * @openfs/core - PathTree
 *
 * In-memory directory tree built from the backing store's file index.
 * Handles ls, cd, find without any network calls.
 * Mirrors Mintlify's ChromaFs __path_tree__ pattern.
 */
import type { PathTreeNode } from "./interface.js";
export declare class PathTree {
    /** Set of all file paths */
    private files;
    /** Map of directory → child names */
    private dirs;
    /** Metadata per path for RBAC */
    private meta;
    constructor();
    /**
     * Build the tree from a path→metadata map (returned by adapter.init())
     * Optionally prune based on user groups for RBAC
     */
    build(pathMap: Map<string, PathTreeNode>, userGroups?: string[]): void;
    /**
     * Check if a user has access to a path based on groups
     */
    private hasAccess;
    /**
     * Normalize a path: ensure leading /, no trailing /, no double /
     */
    private normalizePath;
    /**
     * Check if a path exists (file or directory)
     */
    exists(path: string): boolean;
    /**
     * Check if path is a file
     */
    isFile(path: string): boolean;
    /**
     * Check if path is a directory
     */
    isDirectory(path: string): boolean;
    /**
     * List directory contents (child names only, not full paths)
     */
    readdir(path: string): string[];
    /**
     * Get all file paths (for glob matching)
     */
    getAllPaths(): string[];
    /**
     * Get all directory paths
     */
    getAllDirs(): string[];
    /**
     * Get file count
     */
    get fileCount(): number;
    /**
     * Get directory count
     */
    get dirCount(): number;
}
//# sourceMappingURL=path-tree.d.ts.map