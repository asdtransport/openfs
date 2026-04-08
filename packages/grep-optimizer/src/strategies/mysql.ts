/**
 * MySQL FULLTEXT grep strategy (stub)
 *
 * Translates grep patterns into MySQL MATCH...AGAINST queries.
 */

export function patternToFulltext(
  pattern: string,
  booleanMode = true,
): { query: string; params: string[] } {
  const cleaned = pattern.replace(/['"@+\-<>()~*]/g, " ").trim();

  if (booleanMode) {
    const terms = cleaned
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `+"${t}"`)
      .join(" ");
    return {
      query: `SELECT DISTINCT path FROM files WHERE MATCH(content) AGAINST(? IN BOOLEAN MODE)`,
      params: [terms],
    };
  }

  return {
    query: `SELECT DISTINCT path FROM files WHERE MATCH(content) AGAINST(? IN NATURAL LANGUAGE MODE)`,
    params: [cleaned],
  };
}
