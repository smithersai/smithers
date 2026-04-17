export type RunState =
  | "running"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "recovering"
  | "stale"
  | "orphaned"
  | "failed"
  | "cancelled"
  | "succeeded"
  | "unknown";
