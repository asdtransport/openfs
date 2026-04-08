/**
 * SQLite FTS5 grep strategy
 *
 * Translates grep patterns into FTS5 MATCH queries.
 * Falls back to LIKE for patterns FTS5 can't handle.
 */
export declare function patternToFts5(pattern: string, fixedString?: boolean): string;
export declare function patternToLike(pattern: string, ignoreCase?: boolean): {
    query: string;
    params: string[];
};
//# sourceMappingURL=sqlite.d.ts.map