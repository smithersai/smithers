import { Effect, Layer } from "effect";
import { createMemoryStoreLayer } from "./store/createMemoryStoreLayer.js";
import { MemoryStoreService } from "./store/MemoryStoreService.js";
import { MemoryService } from "./MemoryService.js";
/** @typedef {import("./MemoryLayerConfig.ts").MemoryLayerConfig} MemoryLayerConfig */

/**
 * @param {MemoryLayerConfig} config
 * @returns {Layer.Layer<MemoryService, never, never>}
 */
export function createMemoryLayer(config) {
    return Layer.effect(MemoryService, Effect.map(MemoryStoreService, (store) => ({
        // Working memory
        getFact: (ns, key) => store.getFactEffect(ns, key),
        setFact: (ns, key, value, ttlMs) => store.setFactEffect(ns, key, value, ttlMs),
        deleteFact: (ns, key) => store.deleteFactEffect(ns, key),
        listFacts: (ns) => store.listFactsEffect(ns),
        // Threads & messages
        createThread: (ns, title) => store.createThreadEffect(ns, title),
        getThread: (threadId) => store.getThreadEffect(threadId),
        deleteThread: (threadId) => store.deleteThreadEffect(threadId),
        saveMessage: (msg) => store.saveMessageEffect(msg),
        listMessages: (threadId, limit) => store.listMessagesEffect(threadId, limit),
        countMessages: (threadId) => store.countMessagesEffect(threadId),
        // Maintenance
        deleteExpiredFacts: () => store.deleteExpiredFactsEffect(),
        // Access underlying store
        store,
    }))).pipe(Layer.provide(createMemoryStoreLayer(config.db)));
}
