export type NodeOutputErrorCode =
  | "InvalidRunId"
  | "InvalidNodeId"
  | "InvalidIteration"
  | "RunNotFound"
  | "NodeNotFound"
  | "IterationNotFound"
  | "NodeHasNoOutput"
  | "SchemaConversionError"
  | "MalformedOutputRow"
  | "PayloadTooLarge";
