import type { ChunkStrategy } from "./ChunkStrategy";

export type ChunkOptions = {
  strategy: ChunkStrategy;
  size?: number;
  overlap?: number;
  separator?: string;
};
