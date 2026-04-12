import { Effect } from "effect";
/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */

/**
 * @returns {MemoryProcessor}
 */
export function TtlGarbageCollector() {
    /**
   * @param {MemoryStore} store
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function processEffect(store) {
        return Effect.gen(function* () {
            const deleted = yield* store.deleteExpiredFactsEffect();
            yield* Effect.logInfo(`TtlGarbageCollector: deleted ${deleted} expired facts`);
        }).pipe(Effect.annotateLogs({ processor: "TtlGarbageCollector" }), Effect.withLogSpan("memory:processor:ttl-gc"));
    }
    return {
        name: "TtlGarbageCollector",
        process: (store) => Effect.runPromise(processEffect(store)),
        processEffect,
    };
}
