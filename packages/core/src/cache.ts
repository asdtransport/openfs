/**
 * @openfs/core - Cache
 *
 * Simple in-memory LRU cache for file reads.
 * Prevents repeated hits to the backing store during grep workflows.
 */

import type { CacheBackend } from "./interface.js";

export class InMemoryCache implements CacheBackend {
  private store: Map<string, { value: string; expiresAt?: number }> =
    new Map();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Move to end (most recently used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    // Evict oldest if at capacity
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest) this.store.delete(oldest);
    }
    this.store.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : undefined,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== null;
  }

  /** Clear the entire cache */
  clear(): void {
    this.store.clear();
  }

  /** Current cache size */
  get size(): number {
    return this.store.size;
  }
}
