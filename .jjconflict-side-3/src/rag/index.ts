// Types
export type {
  Document,
  DocumentFormat,
  Chunk,
  ChunkStrategy,
  ChunkOptions,
  EmbeddedChunk,
  RetrievalResult,
  VectorStore,
  VectorQueryOptions,
  RagPipelineConfig,
  RagPipeline,
} from "./types";

// Document
export { createDocument, loadDocument } from "./document";
export type { CreateDocumentOptions } from "./document";

// Chunking
export { chunk } from "./chunker";

// Embedding
export {
  embedChunks,
  embedQuery,
  embedChunksEffect,
  embedQueryEffect,
} from "./embedder";

// Vector store
export {
  createSqliteVectorStore,
  upsertEffect,
  queryEffect,
} from "./vector-store";

// Pipeline
export {
  createRagPipeline,
  ingestEffect,
  retrieveEffect,
} from "./pipeline";

// Tool
export { createRagTool } from "./tool";
export type { RagToolOptions } from "./tool";

// Effect service
export {
  RagService,
  createRagServiceLayer,
  ingest,
  retrieve,
} from "./effect";

// Metrics
export {
  ragIngestCount,
  ragRetrieveCount,
  ragRetrieveDuration,
  ragEmbedDuration,
} from "./metrics";
