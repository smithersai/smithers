export type JumpToFrameErrorCode =
  | "InvalidRunId"
  | "InvalidFrameNo"
  | "RunNotFound"
  | "FrameOutOfRange"
  | "ConfirmationRequired"
  | "Busy"
  | "UnsupportedSandbox"
  | "VcsError"
  | "RewindFailed"
  | "RateLimited"
  | "Unauthorized";
