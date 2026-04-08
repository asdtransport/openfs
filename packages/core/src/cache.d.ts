/**
 * @openfs/core - Cache
 *
 * Simple in-memory LRU cache for file reads.
 * Prevents repeated hits to the backing store during grep workflows.
 */
import type { CacheBackend } from "./interface.js";
export declare class InMemoryCache implements CacheBackend {
    private store;
    private maxSize;
    constructor(maxSize?: number);
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlMs?: number): Promise<void>;
    del(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
    /** Clear the entire cache */
    clear(): void;
    /** Current cache size */
    get size(): number;
}
//# sourceMappingURL=cache.d.ts.map