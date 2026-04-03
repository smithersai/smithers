// Types
export type {
  MemoryNamespace,
  MemoryNamespaceKind,
  MemoryFact,
  MemoryThread,
  MemoryMessage,
  WorkingMemoryConfig,
  SemanticRecallConfig,
  MessageHistoryConfig,
  MemoryProcessorConfig,
  TaskMemoryConfig,
} from "./types";
export { namespaceToString, parseNamespace } from "./types";

// Schema (Drizzle tables)
export {
  smithersMemoryFacts,
  smithersMemoryThreads,
  smithersMemoryMessages,
} from "./schema";

// Store
export { createMemoryStore } from "./store";
export type { MemoryStore } from "./store";

// Semantic
export { createSemanticMemory } from "./semantic";
export type { SemanticMemory } from "./semantic";

// Processors
export {
  TtlGarbageCollector,
  TokenLimiter,
  Summarizer,
} from "./processors";
export type { MemoryProcessor } from "./processors";

// Effect service
export { MemoryService, createMemoryLayer } from "./service";
export type { MemoryServiceApi, MemoryLayerConfig } from "./service";

// Metrics
export {
  memoryFactReads,
  memoryFactWrites,
  memoryRecallQueries,
  memoryMessageSaves,
  memoryRecallDuration,
} from "./metrics";
