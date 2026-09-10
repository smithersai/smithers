import type { BugKv } from "../../src/env.ts";

/**
 * Real in-memory KV with TTL semantics, matching the subset of Cloudflare's
 * KVNamespace the worker uses. Storage is real (a Map), not a route mock —
 * tests exercise the actual fetch handler end-to-end against it.
 */
export function memoryKv(now: () => number = () => Date.now()): BugKv & {
  dump(): Map<string, string>;
} {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  return {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const expiresAt = options?.expirationTtl ? now() + options.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(options) {
      const keys = [...store.keys()].filter((key) => key.startsWith(options.prefix)).sort();
      const offset = Number(options.cursor || 0);
      const end = offset + (options.limit || 1000);
      return { keys: keys.slice(offset, end).map((name) => ({ name })), list_complete: end >= keys.length, cursor: String(end) };
    },
    dump(): Map<string, string> {
      return new Map([...store.entries()].map(([k, v]) => [k, v.value]));
    },
  };
}
