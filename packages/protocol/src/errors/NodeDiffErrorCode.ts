export type NodeDiffErrorCode =
  | "InvalidRunId"
  | "InvalidNodeId"
  | "InvalidIteration"
  | "RunNotFound"
  | "NodeNotFound"
  | "AttemptNotFound"
  | "AttemptNotFinished"
  | "VcsError"
  | "WorkingTreeDirty"
  | "DiffTooLarge";
