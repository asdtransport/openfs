/**
 * PostgreSQL tsvector/trigram grep strategy (stub)
 *
 * Translates grep patterns into PostgreSQL full-text search queries.
 */

export function patternToTsquery(
  pattern: string,
  config = "english",
): { query: string; params: string[] } {
  // Convert pattern to tsquery compatible format
  const terms = pattern
    .split(/\s+/)
    .filter(Boolean)
    .join(" & ");

  return {
    query: `SELECT DISTINCT path FROM files WHERE to_tsvector('${config}', content) @@ to_tsquery('${config}', ?)`,
    params: [terms],
  };
}

export function patternToTrigram(
  pattern: string,
): { query: string; params: string[] } {
  return {
    query: `SELECT DISTINCT path FROM files WHERE content ILIKE ?`,
    params: [`%${pattern}%`],
  };
}
