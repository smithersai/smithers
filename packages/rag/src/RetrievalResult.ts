import type { Chunk } from "./Chunk";

export type RetrievalResult = {
  chunk: Chunk;
  score: number;
  metadata?: Record<string, unknown>;
};
