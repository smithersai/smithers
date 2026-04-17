import type { WorkerTaskError } from "./WorkerTaskError.ts";

export type TaskResult =
	| { _tag: "Success"; executionId: string; terminal: boolean }
	| { _tag: "Failure"; executionId: string; error: WorkerTaskError };
