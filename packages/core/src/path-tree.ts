/**
 * @openfs/core - PathTree
 *
 * In-memory directory tree built from the backing store's file index.
 * Handles ls, cd, find without any network calls.
 * Mirrors Mintlify's ChromaFs __path_tree__ pattern.
 */

import type { PathTreeNode } from "./interface.js";

export class PathTree {
  /** Set of all file paths */
  private files: Set<string> = new Set();
  /** Map of directory → child names */
  private dirs: Map<string, Set<string>> = new Map();
  /** Metadata per path for RBAC */
  private meta: Map<string, PathTreeNode> = new Map();

  constructor() {
    // Root always exists
    this.dirs.set("/", new Set());
  }

  /**
   * Build the tree from a path→metadata map (returned by adapter.init())
   * Optionally prune based on user groups for RBAC
   */
  build(
    pathMap: Map<string, PathTreeNode>,
    userGroups?: string[],
  ): void {
    this.files.clear();
    this.dirs.clear();
    this.dirs.set("/", new Set());

    for (const [filePath, node] of pathMap) {
      // RBAC: prune paths the user can't access
      if (userGroups && !this.hasAccess(node, userGroups)) {
        continue;
      }

      const normalizedPath = this.normalizePath(filePath);
      this.files.add(normalizedPath);
      this.meta.set(normalizedPath, node);

      // Build parent directory chain
      const parts = normalizedPath.split("/").filter(Boolean);
      let current = "";
      for (let i = 0; i < parts.length; i++) {
        const parent = current || "/";
        const child = parts[i];
        current = `${current}/${child}`;

        if (!this.dirs.has(parent)) {
          this.dirs.set(parent, new Set());
        }

        if (i < parts.length - 1) {
          // Intermediate directory
          this.dirs.get(parent)!.add(child);
          if (!this.dirs.has(current)) {
            this.dirs.set(current, new Set());
          }
        } else {
          // Leaf file
          this.dirs.get(parent)!.add(child);
        }
      }
    }
  }

  /**
   * Check if a user has access to a path based on groups
   */
  private hasAccess(node: PathTreeNode, userGroups: string[]): boolean {
    if (node.isPublic) return true;
    if (!node.groups || node.groups.length === 0) return true;
    return node.groups.some((g) => userGroups.includes(g));
  }

  /**
   * Normalize a path: ensure leading /, no trailing /, no double /
   */
  private normalizePath(path: string): string {
    let p = path.startsWith("/") ? path : `/${path}`;
    p = p.replace(/\/+/g, "/");
    if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
    return p;
  }

  /**
   * Check if a path exists (file or directory)
   */
  exists(path: string): boolean {
    const p = this.normalizePath(path);
    return this.files.has(p) || this.dirs.has(p);
  }

  /**
   * Check if path is a file
   */
  isFile(path: string): boolean {
    return this.files.has(this.normalizePath(path));
  }

  /**
   * Check if path is a directory
   */
  isDirectory(path: string): boolean {
    return this.dirs.has(this.normalizePath(path));
  }

  /**
   * List directory contents (child names only, not full paths)
   */
  readdir(path: string): string[] {
    const p = this.normalizePath(path);
    const children = this.dirs.get(p);
    if (!children) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    return Array.from(children).sort();
  }

  /**
   * Get all file paths (for glob matching)
   */
  getAllPaths(): string[] {
    return Array.from(this.files);
  }

  /**
   * Get all directory paths
   */
  getAllDirs(): string[] {
    return Array.from(this.dirs.keys());
  }

  /**
   * Get file count
   */
  get fileCount(): number {
    return this.files.size;
  }

  /**
   * Get directory count
   */
  get dirCount(): number {
    return this.dirs.size;
  }
}
