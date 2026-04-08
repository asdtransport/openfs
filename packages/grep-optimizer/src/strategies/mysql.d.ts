/**
 * MySQL FULLTEXT grep strategy (stub)
 *
 * Translates grep patterns into MySQL MATCH...AGAINST queries.
 */
export declare function patternToFulltext(pattern: string, booleanMode?: boolean): {
    query: string;
    params: string[];
};
//# sourceMappingURL=mysql.d.ts.map