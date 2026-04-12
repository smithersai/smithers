import { Effect } from "effect";
/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */

/**
 * @param {number} maxTokens
 * @returns {MemoryProcessor}
 */
export function TokenLimiter(maxTokens) {
    // Rough approximation: 1 token ~= 4 characters
    const charBudget = maxTokens * 4;
    /**
   * @param {MemoryStore} store
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function processEffect(store) {
        return Effect.gen(function* () {
            // Token limiter operates at the thread level; without a specific thread
            // context it logs and returns. In practice, this processor is invoked
            // with a store that wraps a specific thread. For now, this is a no-op
            // placeholder that documents the intended behaviour.
            yield* Effect.logInfo(`TokenLimiter: configured for ${maxTokens} tokens (${charBudget} chars) — operates at thread level`);
        }).pipe(Effect.annotateLogs({ processor: "TokenLimiter", maxTokens }), Effect.withLogSpan("memory:processor:token-limiter"));
    }
    return {
        name: "TokenLimiter",
        process: (store) => Effect.runPromise(processEffect(store)),
        processEffect,
    };
}
