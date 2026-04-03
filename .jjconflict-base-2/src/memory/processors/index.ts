import { Effect, Metric } from "effect";
import { fromPromise } from "../../effect/interop";
import { runPromise } from "../../effect/runtime";
import type { SmithersError } from "../../utils/errors";
import type { MemoryStore } from "../store";

// ---------------------------------------------------------------------------
// Processor interface
// ---------------------------------------------------------------------------

export type MemoryProcessor = {
  name: string;
  process: (store: MemoryStore) => Promise<void>;
  processEffect: (store: MemoryStore) => Effect.Effect<void, SmithersError>;
};

// ---------------------------------------------------------------------------
// TTL Garbage Collector
// ---------------------------------------------------------------------------

export function TtlGarbageCollector(): MemoryProcessor {
  function processEffect(store: MemoryStore): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      const deleted = yield* store.deleteExpiredFactsEffect();
      yield* Effect.logInfo(`TtlGarbageCollector: deleted ${deleted} expired facts`);
    }).pipe(
      Effect.annotateLogs({ processor: "TtlGarbageCollector" }),
      Effect.withLogSpan("memory:processor:ttl-gc"),
    );
  }

  return {
    name: "TtlGarbageCollector",
    process: (store) => runPromise(processEffect(store)),
    processEffect,
  };
}

// ---------------------------------------------------------------------------
// Token Limiter — truncates message history that exceeds a token budget
// ---------------------------------------------------------------------------

export function TokenLimiter(maxTokens: number): MemoryProcessor {
  // Rough approximation: 1 token ~= 4 characters
  const charBudget = maxTokens * 4;

  function processEffect(store: MemoryStore): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      // Token limiter operates at the thread level; without a specific thread
      // context it logs and returns. In practice, this processor is invoked
      // with a store that wraps a specific thread. For now, this is a no-op
      // placeholder that documents the intended behaviour.
      yield* Effect.logInfo(
        `TokenLimiter: configured for ${maxTokens} tokens (${charBudget} chars) — operates at thread level`,
      );
    }).pipe(
      Effect.annotateLogs({ processor: "TokenLimiter", maxTokens }),
      Effect.withLogSpan("memory:processor:token-limiter"),
    );
  }

  return {
    name: "TokenLimiter",
    process: (store) => runPromise(processEffect(store)),
    processEffect,
  };
}

// ---------------------------------------------------------------------------
// Summarizer — uses an LLM agent to summarize old messages
// ---------------------------------------------------------------------------

export function Summarizer(agent: { run: (prompt: string) => Promise<any> }): MemoryProcessor {
  function processEffect(store: MemoryStore): Effect.Effect<void, SmithersError> {
    return Effect.gen(function* () {
      // Summarizer operates on a specific thread's messages, compressing
      // older messages into a summary. Without a thread context, it logs
      // and returns. This is a structural placeholder.
      yield* Effect.logInfo("Summarizer: configured — operates at thread level");
    }).pipe(
      Effect.annotateLogs({ processor: "Summarizer" }),
      Effect.withLogSpan("memory:processor:summarizer"),
    );
  }

  return {
    name: "Summarizer",
    process: (store) => runPromise(processEffect(store)),
    processEffect,
  };
}
