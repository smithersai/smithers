import type { EmbeddedChunk } from "./EmbeddedChunk";
import type { RetrievalResult } from "./RetrievalResult";
import type { VectorQueryOptions } from "./VectorQueryOptions";

export interface VectorStore {
  upsert(chunks: EmbeddedChunk[], namespace?: string): Promise<void>;
  query(
    embedding: number[],
    options?: VectorQueryOptions,
  ): Promise<RetrievalResult[]>;
  delete(ids: string[]): Promise<void>;
  count(namespace?: string): Promise<number>;
}
