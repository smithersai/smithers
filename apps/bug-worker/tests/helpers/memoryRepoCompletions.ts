import { RepoCompletion } from "../../src/RepoCompletion.ts";
import type { BugWorkerEnv } from "../../src/env.ts";

/** Runs the deployed class against isolated, atomic, rollback-capable storage. */
export function memoryRepoCompletions(): BugWorkerEnv["REPO_COMPLETIONS"] {
  const stores = new Map<string, { values: Map<string, unknown>; tail: Promise<unknown> }>();
  return {
    getByName(name) {
      let store = stores.get(name);
      if (!store) {
        store = { values: new Map(), tail: Promise.resolve() };
        stores.set(name, store);
      }
      const state = store;
      // Construct afresh on every access so tests cannot rely on instance memory.
      return new RepoCompletion({ storage: {
        transaction(callback) {
          const result = state.tail.then(async () => {
            const pending = structuredClone(state.values);
            const value = await callback({
              async get<T>(key: string) { return structuredClone(pending.get(key)) as T | undefined; },
              async put<T>(key: string, value: T) { pending.set(key, structuredClone(value)); },
            });
            state.values = pending;
            return value;
          });
          state.tail = result.catch(() => {});
          return result;
        },
      } });
    },
  };
}
