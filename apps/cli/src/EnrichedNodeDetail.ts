import type { NodeDetailAttempt } from "./NodeDetailAttempt.ts";
import type { NodeDetailToolCall } from "./NodeDetailToolCall.ts";
import type { NodeDetailTokenUsage } from "./NodeDetailTokenUsage.ts";

type AttemptSummary = {
    total: number;
    failed: number;
    cancelled: number;
    succeeded: number;
    waiting: number;
};

export type EnrichedNodeDetail = {
    node: {
        runId: string;
        nodeId: string;
        iteration: number;
        state: string;
        lastAttempt: number | null;
        updatedAtMs: number | null;
        outputTable: string | null;
        label: string | null;
    };
    status: string;
    durationMs: number | null;
    attemptsSummary: AttemptSummary;
    attempts: NodeDetailAttempt[];
    toolCalls: NodeDetailToolCall[];
    tokenUsage: NodeDetailTokenUsage & {
        byAttempt: Array<{
            attempt: number;
            usage: NodeDetailTokenUsage;
        }>;
    };
    scorers: Array<{
        id: string;
        attempt: number;
        scorerId: string;
        scorerName: string;
        source: string;
        score: number;
        reason: string | null;
        latencyMs: number | null;
        durationMs: number | null;
        scoredAtMs: number;
        meta: unknown | null;
        input: unknown | null;
        output: unknown | null;
    }>;
    output: {
        validated: unknown | null;
        raw: unknown | null;
        source: "cache" | "output-table" | "none";
        cacheKey: string | null;
    };
    limits: {
        toolPayloadBytesHuman: number;
        validatedOutputBytesHuman: number;
    };
};
