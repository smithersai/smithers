import type { TaskActivityRetryOptions } from "./TaskActivityRetryOptions.ts";

export type ExecuteTaskActivityOptions = {
	initialAttempt?: number;
	retry?: false | TaskActivityRetryOptions;
	includeAttemptInIdempotencyKey?: boolean;
};
