import type { EmbeddingModel } from "ai";
import type { VectorStore } from "./VectorStore";
import type { ChunkOptions } from "./ChunkOptions";

export type RagPipelineConfig = {
  vectorStore: VectorStore;
  embeddingModel: EmbeddingModel;
  chunkOptions?: ChunkOptions;
  topK?: number;
  namespace?: string;
};
