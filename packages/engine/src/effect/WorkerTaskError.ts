import type { TaggedWorkerError } from "./TaggedWorkerError.ts";
import type { UnknownWorkerError } from "./UnknownWorkerError.ts";

export type WorkerTaskError = TaggedWorkerError | UnknownWorkerError;
