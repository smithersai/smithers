import { Effect, Layer } from "effect";
import { createMemoryStoreLayer } from "./store/createMemoryStoreLayer";
import { MemoryStoreService } from "./store/MemoryStoreService";
import { MemoryService } from "./MemoryService";
import type { MemoryLayerConfig } from "./MemoryLayerConfig";

export function createMemoryLayer(config: MemoryLayerConfig) {
  return Layer.effect(
    MemoryService,
    Effect.map(MemoryStoreService, (store) => ({
      // Working memory
      getFact: (ns: any, key: any) => store.getFactEffect(ns, key),
      setFact: (ns: any, key: any, value: any, ttlMs?: any) =>
        store.setFactEffect(ns, key, value, ttlMs),
      deleteFact: (ns: any, key: any) => store.deleteFactEffect(ns, key),
      listFacts: (ns: any) => store.listFactsEffect(ns),

      // Threads & messages
      createThread: (ns: any, title?: any) => store.createThreadEffect(ns, title),
      getThread: (threadId: any) => store.getThreadEffect(threadId),
      deleteThread: (threadId: any) => store.deleteThreadEffect(threadId),
      saveMessage: (msg: any) => store.saveMessageEffect(msg),
      listMessages: (threadId: any, limit?: any) =>
        store.listMessagesEffect(threadId, limit),
      countMessages: (threadId: any) => store.countMessagesEffect(threadId),

      // Maintenance
      deleteExpiredFacts: () => store.deleteExpiredFactsEffect(),

      // Access underlying store
      store,
    })),
  ).pipe(Layer.provide(createMemoryStoreLayer(config.db)));
}
