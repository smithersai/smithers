export type SnapshotSerializerWarning = {
  code:
    | "CircularReference"
    | "MaxDepthExceeded"
    | "MaxEntriesExceeded"
    | "UnsupportedType";
  path: string;
  detail?: string;
};
