import type { EmbeddingModel } from "ai";

// Re-export the non-generic EmbeddingModel for convenience
export type { EmbeddingModel } from "ai";

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export type DocumentFormat = "text" | "markdown" | "html" | "json";

export type Document = {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  format?: DocumentFormat;
};

// ---------------------------------------------------------------------------
// Chunk
// ---------------------------------------------------------------------------

export type Chunk = {
  id: string;
  documentId: string;
  content: string;
  index: number;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export type ChunkStrategy =
  | "recursive"
  | "character"
  | "sentence"
  | "markdown"
  | "token";

export type ChunkOptions = {
  strategy: ChunkStrategy;
  size?: number;
  overlap?: number;
  separator?: string;
};

// ---------------------------------------------------------------------------
// Embedded chunk
// ---------------------------------------------------------------------------

export type EmbeddedChunk = Chunk & {
  embedding: number[];
};

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export type RetrievalResult = {
  chunk: Chunk;
  score: number;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Vector store
// ---------------------------------------------------------------------------

export type VectorQueryOptions = {
  topK?: number;
  namespace?: string;
  filter?: Record<string, unknown>;
};

export interface VectorStore {
  upsert(chunks: EmbeddedChunk[], namespace?: string): Promise<void>;
  query(
    embedding: number[],
    options?: VectorQueryOptions,
  ): Promise<RetrievalResult[]>;
  delete(ids: string[]): Promise<void>;
  count(namespace?: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Pipeline config
// ---------------------------------------------------------------------------

export type RagPipelineConfig = {
  vectorStore: VectorStore;
  embeddingModel: EmbeddingModel;
  chunkOptions?: ChunkOptions;
  topK?: number;
  namespace?: string;
};

export type RagPipeline = {
  ingest(documents: Document[]): Promise<void>;
  ingestFile(path: string): Promise<void>;
  retrieve(query: string, opts?: { topK?: number }): Promise<RetrievalResult[]>;
};
