/**
 * @openfs/grep-optimizer
 *
 * Two-phase grep optimization for OpenFS adapters.
 */

export {
  parseGrepFlags,
  optimizeGrep,
  rewriteGrepCommand,
} from "./grep-optimizer.js";

// Strategies
export { patternToFts5, patternToLike } from "./strategies/sqlite.js";
export { patternToChromaWhere } from "./strategies/chroma.js";
export { patternToFulltext } from "./strategies/mysql.js";
export { patternToTsquery, patternToTrigram } from "./strategies/postgres.js";
