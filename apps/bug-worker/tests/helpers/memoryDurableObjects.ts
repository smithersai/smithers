import type { State } from "../../src/durableState.ts";
import { RateLimiter } from "../../src/RateLimiter.ts";

type DurableObject = { fetch(request: Request): Promise<Response>; alarm?(): Promise<void> };
type Namespace = { getByName(name: string): { fetch(request: Request): Promise<Response> } };
type Store = { values: Map<string, unknown>; tail: Promise<unknown>; alarm: number | null };

/**
 * Runs a deployed Durable Object class against isolated, atomic, rollback-capable
 * storage per name. `stored` and `alarmAt` expose an object's storage and its
 * scheduled alarm; `fireAlarms(now)` runs every alarm due at `now`, as workerd does.
 */
function memoryDurableObjects(make: (state: State) => DurableObject): Namespace & {
  stored(name: string): Map<string, unknown>;
  alarmAt(name: string): number | null;
  fireAlarms(now: number): Promise<void>;
} {
  const stores = new Map<string, Store>();
  const storeOf = (name: string): Store => {
    let store = stores.get(name);
    if (!store) {
      store = { values: new Map(), tail: Promise.resolve(), alarm: null };
      stores.set(name, store);
    }
    return store;
  };
  // Construct afresh on every access so tests cannot rely on instance memory.
  const open = (state: Store) => make({ storage: {
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
    async setAlarm(scheduledTime) { state.alarm = scheduledTime; },
    async deleteAll() { state.values = new Map(); },
  } });
  return {
    getByName: (name) => open(storeOf(name)),
    stored: (name) => new Map(storeOf(name).values),
    alarmAt: (name) => storeOf(name).alarm,
    async fireAlarms(now) {
      for (const state of stores.values()) {
        if (state.alarm === null || state.alarm > now) continue;
        state.alarm = null;
        await open(state).alarm?.();
      }
    },
  };
}

export const memoryRateLimits = () => memoryDurableObjects((state) => new RateLimiter(state));
