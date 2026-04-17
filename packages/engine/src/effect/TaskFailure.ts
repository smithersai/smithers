import type { TaskResult } from "./TaskResult.ts";

export type TaskFailure = Extract<TaskResult, { _tag: "Failure" }>;
