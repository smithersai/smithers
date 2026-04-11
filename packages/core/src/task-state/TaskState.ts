export type TaskState =
  | "pending"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "in-progress"
  | "finished"
  | "failed"
  | "cancelled"
  | "skipped";
