/**
 * SQLite FTS5 grep strategy
 *
 * Translates grep patterns into FTS5 MATCH queries.
 * Falls back to LIKE for patterns FTS5 can't handle.
 */

export function patternToFts5(pattern: string, fixedString = false): string {
  // FTS5 special chars that need escaping
  const cleaned = pattern.replace(/['"]/g, "").replace(/[*(){}[\]^~]/g, " ");

  if (fixedString || !/[.+?|\\[\](){}^$]/.test(pattern)) {
    // Fixed string or no regex metacharacters: phrase match
    return `"${cleaned}"`;
  }

  // Multiple words: AND each as a phrase
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return words.map((w) => `"${w}"`).join(" ");
}

export function patternToLike(
  pattern: string,
  ignoreCase = false,
): { query: string; params: string[] } {
  // Simple LIKE fallback
  const escaped = pattern.replace(/%/g, "\\%").replace(/_/g, "\\_");
  const likePattern = `%${escaped}%`;

  if (ignoreCase) {
    return {
      query: `SELECT DISTINCT path FROM files WHERE content LIKE ? ESCAPE '\\'`,
      params: [likePattern],
    };
  }
  return {
    query: `SELECT DISTINCT path FROM files WHERE content LIKE ? ESCAPE '\\'`,
    params: [likePattern],
  };
}
