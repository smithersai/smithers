export type JumpStepName =
  | "snapshot-pre-jump"
  | "pause-event-loop"
  | "revert-sandboxes"
  | "truncate-frames"
  | "truncate-attempts"
  | "truncate-outputs"
  | "invalidate-diffs"
  | "rebuild-reconciler"
  | "resume-event-loop";
