import type { NodeDetailToolCall } from "./NodeDetailToolCall.ts";
import type { NodeDetailTokenUsage } from "./NodeDetailTokenUsage.ts";

export type NodeDetailAttempt = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    state: string;
    startedAtMs: number;
    finishedAtMs: number | null;
    durationMs: number | null;
    error: string | null;
    errorDetail: unknown | null;
    tokenUsage: NodeDetailTokenUsage;
    toolCalls: NodeDetailToolCall[];
    meta: unknown | null;
    responseText: string | null;
    cached: boolean;
    jjPointer: string | null;
    jjCwd: string | null;
};
