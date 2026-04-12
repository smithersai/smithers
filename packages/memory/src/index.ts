// Types
export type { MemoryNamespace } from "./MemoryNamespace";
export type { MemoryNamespaceKind } from "./MemoryNamespaceKind";
export type { MemoryFact } from "./MemoryFact";
export type { MemoryThread } from "./MemoryThread";
export type { MemoryMessage } from "./MemoryMessage";
export type { WorkingMemoryConfig } from "./WorkingMemoryConfig";
export type { SemanticRecallConfig } from "./SemanticRecallConfig";
export type { MessageHistoryConfig } from "./MessageHistoryConfig";
export type { MemoryProcessorConfig } from "./MemoryProcessorConfig";
export type { TaskMemoryConfig } from "./TaskMemoryConfig";
export { namespaceToString } from "./namespaceToString";
export { parseNamespace } from "./parseNamespace";

// Schema (Drizzle tables)
export {
  smithersMemoryFacts,
  smithersMemoryThreads,
  smithersMemoryMessages,
} from "./schema";

// Store
export { createMemoryStore } from "./store/createMemoryStore";
export type { MemoryStore } from "./store/MemoryStore";

// Processors
export { TtlGarbageCollector } from "./TtlGarbageCollector";
export { TokenLimiter } from "./TokenLimiter";
export { Summarizer } from "./Summarizer";
export type { MemoryProcessor } from "./MemoryProcessor";

// Effect service
export { MemoryService } from "./MemoryService";
export { createMemoryLayer } from "./createMemoryLayer";
export type { MemoryServiceApi } from "./MemoryServiceApi";
export type { MemoryLayerConfig } from "./MemoryLayerConfig";

// Metrics
export { memoryFactReads } from "./memoryFactReads";
export { memoryFactWrites } from "./memoryFactWrites";
export { memoryRecallQueries } from "./memoryRecallQueries";
export { memoryMessageSaves } from "./memoryMessageSaves";
export { memoryRecallDuration } from "./memoryRecallDuration";
