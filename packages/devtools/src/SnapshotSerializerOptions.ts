import type { SnapshotSerializerWarning } from "./SnapshotSerializerWarning.ts";

export type SnapshotSerializerOptions = {
  maxDepth?: number;
  maxEntries?: number;
  onWarning?: (warning: SnapshotSerializerWarning) => void;
};
