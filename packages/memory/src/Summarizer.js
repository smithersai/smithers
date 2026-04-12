import { Effect } from "effect";
/** @typedef {import("./MemoryProcessor.ts").MemoryProcessor} MemoryProcessor */

/**
 * @param {{ run: (prompt: string) => Promise<any> }} agent
 * @returns {MemoryProcessor}
 */
export function Summarizer(agent) {
    /**
   * @param {MemoryStore} store
   * @returns {Effect.Effect<void, SmithersError>}
   */
    function processEffect(store) {
        return Effect.gen(function* () {
            // Summarizer operates on a specific thread's messages, compressing
            // older messages into a summary. Without a thread context, it logs
            // and returns. This is a structural placeholder.
            yield* Effect.logInfo("Summarizer: configured — operates at thread level");
        }).pipe(Effect.annotateLogs({ processor: "Summarizer" }), Effect.withLogSpan("memory:processor:summarizer"));
    }
    return {
        name: "Summarizer",
        process: (store) => Effect.runPromise(processEffect(store)),
        processEffect,
    };
}
