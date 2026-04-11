// Types
export type { Document } from "./document";
export type { DocumentFormat } from "./DocumentFormat";
export type { Chunk } from "./Chunk";
export type { ChunkStrategy } from "./ChunkStrategy";
export type { ChunkOptions } from "./ChunkOptions";
export type { EmbeddedChunk } from "./EmbeddedChunk";
export type { RetrievalResult } from "./RetrievalResult";
export type { VectorStore } from "./VectorStore";
export type { VectorQueryOptions } from "./VectorQueryOptions";
export type { RagPipelineConfig } from "./RagPipelineConfig";
export type { RagPipeline } from "./RagPipeline";

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
export { ragIngestCount } from "./ragIngestCount";
export { ragRetrieveCount } from "./ragRetrieveCount";
export { ragRetrieveDuration } from "./ragRetrieveDuration";
export { ragEmbedDuration } from "./ragEmbedDuration";
