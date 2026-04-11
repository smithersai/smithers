export type RunStatus =
  | "running"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "finished"
  | "continued"
  | "failed"
  | "cancelled";
