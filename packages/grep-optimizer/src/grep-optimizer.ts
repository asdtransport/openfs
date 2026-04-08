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

import type {
  CacheBackend,
  GrepFlags,
  OpenFsAdapter,
  SearchResult,
} from "@openfs/core";

/**
 * Parse grep flags from a raw command string.
 * Extracts flags and pattern/paths for adapter search.
 */
export function parseGrepFlags(args: string[]): GrepFlags {
  const flags: GrepFlags = {
    ignoreCase: false,
    recursive: false,
    fixedStrings: false,
    extendedRegex: false,
    invertMatch: false,
    wordRegex: false,
    lineRegex: false,
    pattern: "",
    paths: [],
  };

  let i = 0;
  let patternFound = false;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "--") {
      i++;
      break;
    }

    // Long flags
    if (arg === "--ignore-case") { flags.ignoreCase = true; i++; continue; }
    if (arg === "--recursive") { flags.recursive = true; i++; continue; }
    if (arg === "--fixed-strings") { flags.fixedStrings = true; i++; continue; }
    if (arg === "--extended-regexp") { flags.extendedRegex = true; i++; continue; }
    if (arg === "--invert-match") { flags.invertMatch = true; i++; continue; }
    if (arg === "--word-regexp") { flags.wordRegex = true; i++; continue; }
    if (arg === "--line-regexp") { flags.lineRegex = true; i++; continue; }
    if (arg === "--max-count") { flags.maxCount = parseInt(args[++i], 10); i++; continue; }

    // Short flags (can be combined: -ri, -rni, etc.)
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 1) {
      let isFlag = true;
      for (let j = 1; j < arg.length; j++) {
        const c = arg[j];
        if (c === "i") flags.ignoreCase = true;
        else if (c === "r" || c === "R") flags.recursive = true;
        else if (c === "F") flags.fixedStrings = true;
        else if (c === "E") flags.extendedRegex = true;
        else if (c === "v") flags.invertMatch = true;
        else if (c === "w") flags.wordRegex = true;
        else if (c === "x") flags.lineRegex = true;
        else if (c === "n" || c === "l" || c === "c" || c === "H" || c === "h") {
          // Common flags we recognize but don't need for search
        }
        else if (c === "m") {
          flags.maxCount = parseInt(args[++i], 10);
          break;
        }
        else if (c === "e") {
          // -e PATTERN
          flags.pattern = args[++i] ?? "";
          patternFound = true;
          break;
        }
        else { isFlag = false; break; }
      }
      if (isFlag) { i++; continue; }
    }

    // Not a flag — it's the pattern or a path
    if (!patternFound) {
      flags.pattern = arg;
      patternFound = true;
    } else {
      flags.paths.push(arg);
    }
    i++;
  }

  // Remaining args after -- are paths
  while (i < args.length) {
    flags.paths.push(args[i++]);
  }

  return flags;
}

/**
 * Run the two-phase grep optimization.
 *
 * @returns List of file paths that should be searched (narrowed from full corpus)
 */
export async function optimizeGrep(
  adapter: OpenFsAdapter,
  flags: GrepFlags,
  cache?: CacheBackend,
): Promise<{ candidates: SearchResult[]; prefetched: Map<string, string> }> {
  // Phase 1: Coarse filter via adapter's native search
  const candidates = await adapter.search(flags.pattern, flags);

  if (candidates.length === 0) {
    return { candidates: [], prefetched: new Map() };
  }

  // Phase 2: Bulk prefetch matched files into cache
  const paths = candidates.map((c) => c.path);
  const prefetched = await adapter.bulkPrefetch(paths);

  // Push into cache if provided
  if (cache) {
    for (const [path, content] of prefetched) {
      await cache.set(`file:${path}`, content);
    }
  }

  return { candidates, prefetched };
}

/**
 * Rewrite a grep command to target only candidate files.
 * This is the command that gets handed back to just-bash.
 */
export function rewriteGrepCommand(
  originalArgs: string[],
  candidatePaths: string[],
): string[] {
  if (candidatePaths.length === 0) return [];

  const flags = parseGrepFlags(originalArgs);
  const newArgs: string[] = [];

  // Rebuild flag string
  if (flags.ignoreCase) newArgs.push("-i");
  if (flags.extendedRegex) newArgs.push("-E");
  if (flags.fixedStrings) newArgs.push("-F");
  if (flags.invertMatch) newArgs.push("-v");
  if (flags.wordRegex) newArgs.push("-w");
  if (flags.lineRegex) newArgs.push("-x");
  if (flags.maxCount !== undefined) newArgs.push("-m", String(flags.maxCount));
  // Do NOT pass -r: we're giving explicit file paths now
  newArgs.push("-n"); // line numbers

  // Pattern
  newArgs.push(flags.pattern);

  // Replace directory targets with specific files
  newArgs.push(...candidatePaths);

  return newArgs;
}
