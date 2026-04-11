import type { Chunk } from "./Chunk";

export type EmbeddedChunk = Chunk & {
  embedding: number[];
};
