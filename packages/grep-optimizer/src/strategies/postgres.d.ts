/**
 * PostgreSQL tsvector/trigram grep strategy (stub)
 *
 * Translates grep patterns into PostgreSQL full-text search queries.
 */
export declare function patternToTsquery(pattern: string, config?: string): {
    query: string;
    params: string[];
};
export declare function patternToTrigram(pattern: string): {
    query: string;
    params: string[];
};
//# sourceMappingURL=postgres.d.ts.map