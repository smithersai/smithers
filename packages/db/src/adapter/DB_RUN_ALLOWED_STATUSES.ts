export const DB_RUN_ALLOWED_STATUSES = [
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "finished",
  "failed",
  "cancelled",
  "continued",
] as const;
