import { TaskAborted } from "@smithers/errors/TaskAborted";
export declare function makeAbortError(message?: string): TaskAborted;
export declare function wireAbortSignal(controller: AbortController, signal?: AbortSignal): () => void;
export declare function parseAttemptMetaJson(metaJson?: string | null): Record<string, unknown>;
