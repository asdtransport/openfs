/**
 * @openfs/grep-optimizer
 *
 * Two-phase grep optimization:
 *   1. Coarse filter: Use adapter's native search (FTS5, FULLTEXT, $contains)
 *      to find candidate files
 *   2. Fine filter: Hand narrowed file list back to just-bash for in-memory
 *      regex execution
 *
 * Mirrors Mintlify's ChromaFs grep interception pattern.
 */
import type { CacheBackend, GrepFlags, OpenFsAdapter, SearchResult } from "@openfs/core";
/**
 * Parse grep flags from a raw command string.
 * Extracts flags and pattern/paths for adapter search.
 */
export declare function parseGrepFlags(args: string[]): GrepFlags;
/**
 * Run the two-phase grep optimization.
 *
 * @returns List of file paths that should be searched (narrowed from full corpus)
 */
export declare function optimizeGrep(adapter: OpenFsAdapter, flags: GrepFlags, cache?: CacheBackend): Promise<{
    candidates: SearchResult[];
    prefetched: Map<string, string>;
}>;
/**
 * Rewrite a grep command to target only candidate files.
 * This is the command that gets handed back to just-bash.
 */
export declare function rewriteGrepCommand(originalArgs: string[], candidatePaths: string[]): string[];
//# sourceMappingURL=grep-optimizer.d.ts.map