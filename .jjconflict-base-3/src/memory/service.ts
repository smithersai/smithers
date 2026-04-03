import { Context, Effect, Layer } from "effect";
import type { EmbeddingModel } from "ai";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { SmithersError } from "../utils/errors";
import type { VectorStore, RetrievalResult } from "../rag/types";
import type {
  MemoryNamespace,
  MemoryFact,
  MemoryThread,
  MemoryMessage,
  SemanticRecallConfig,
} from "./types";
import { createMemoryStore, type MemoryStore } from "./store";
import { createSemanticMemory, type SemanticMemory } from "./semantic";

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export type MemoryServiceApi = {
  // Working memory
  readonly getFact: (
    ns: MemoryNamespace,
    key: string,
  ) => Effect.Effect<MemoryFact | undefined, SmithersError>;
  readonly setFact: (
    ns: MemoryNamespace,
    key: string,
    value: unknown,
    ttlMs?: number,
  ) => Effect.Effect<void, SmithersError>;
  readonly deleteFact: (
    ns: MemoryNamespace,
    key: string,
  ) => Effect.Effect<void, SmithersError>;
  readonly listFacts: (
    ns: MemoryNamespace,
  ) => Effect.Effect<MemoryFact[], SmithersError>;

  // Semantic recall
  readonly remember: (
    ns: MemoryNamespace,
    content: string,
    metadata?: Record<string, unknown>,
  ) => Effect.Effect<void, SmithersError>;
  readonly recall: (
    ns: MemoryNamespace,
    query: string,
    config?: SemanticRecallConfig,
  ) => Effect.Effect<RetrievalResult[], SmithersError>;

  // Threads & messages
  readonly createThread: (
    ns: MemoryNamespace,
    title?: string,
  ) => Effect.Effect<MemoryThread, SmithersError>;
  readonly getThread: (
    threadId: string,
  ) => Effect.Effect<MemoryThread | undefined, SmithersError>;
  readonly deleteThread: (
    threadId: string,
  ) => Effect.Effect<void, SmithersError>;
  readonly saveMessage: (
    msg: Omit<MemoryMessage, "createdAtMs"> & { createdAtMs?: number },
  ) => Effect.Effect<void, SmithersError>;
  readonly listMessages: (
    threadId: string,
    limit?: number,
  ) => Effect.Effect<MemoryMessage[], SmithersError>;
  readonly countMessages: (
    threadId: string,
  ) => Effect.Effect<number, SmithersError>;

  // Maintenance
  readonly deleteExpiredFacts: () => Effect.Effect<number, SmithersError>;

  // Access underlying stores
  readonly store: MemoryStore;
  readonly semantic: SemanticMemory | null;
};

// ---------------------------------------------------------------------------
// Tag
// ---------------------------------------------------------------------------

export class MemoryService extends Context.Tag("MemoryService")<
  MemoryService,
  MemoryServiceApi
>() {}

// ---------------------------------------------------------------------------
// Layer config
// ---------------------------------------------------------------------------

export type MemoryLayerConfig = {
  db: BunSQLiteDatabase<any>;
  vectorStore?: VectorStore;
  embeddingModel?: EmbeddingModel;
};

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

export function createMemoryLayer(config: MemoryLayerConfig) {
  const store = createMemoryStore(config.db);
  const semantic =
    config.vectorStore && config.embeddingModel
      ? createSemanticMemory(config.vectorStore, config.embeddingModel)
      : null;

  const noSemanticError = (): Effect.Effect<never, SmithersError> =>
    Effect.fail({
      _tag: "SmithersError",
      code: "MEMORY_SEMANTIC_NOT_CONFIGURED",
      message: "Semantic memory requires vectorStore and embeddingModel in config",
    } as any);

  return Layer.succeed(MemoryService, {
    // Working memory
    getFact: (ns, key) => store.getFactEffect(ns, key),
    setFact: (ns, key, value, ttlMs) => store.setFactEffect(ns, key, value, ttlMs),
    deleteFact: (ns, key) => store.deleteFactEffect(ns, key),
    listFacts: (ns) => store.listFactsEffect(ns),

    // Semantic
    remember: (ns, content, metadata) =>
      semantic ? semantic.rememberEffect(ns, content, metadata) : noSemanticError(),
    recall: (ns, query, config) =>
      semantic ? semantic.recallEffect(ns, query, config) : noSemanticError(),

    // Threads & messages
    createThread: (ns, title) => store.createThreadEffect(ns, title),
    getThread: (threadId) => store.getThreadEffect(threadId),
    deleteThread: (threadId) => store.deleteThreadEffect(threadId),
    saveMessage: (msg) => store.saveMessageEffect(msg),
    listMessages: (threadId, limit) => store.listMessagesEffect(threadId, limit),
    countMessages: (threadId) => store.countMessagesEffect(threadId),

    // Maintenance
    deleteExpiredFacts: () => store.deleteExpiredFactsEffect(),

    // Access underlying stores
    store,
    semantic,
  });
}
