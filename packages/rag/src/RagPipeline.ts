import type { Document } from "./document";
import type { RetrievalResult } from "./RetrievalResult";

export type RagPipeline = {
  ingest(documents: Document[]): Promise<void>;
  ingestFile(path: string): Promise<void>;
  retrieve(query: string, opts?: { topK?: number }): Promise<RetrievalResult[]>;
};
