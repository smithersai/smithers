import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors";
export type NodeDetailToolCall = {
    attempt: number;
    seq: number;
    name: string;
    status: string;
    startedAtMs: number;
    finishedAtMs: number | null;
    durationMs: number | null;
    input: unknown | null;
    output: unknown | null;
    error: string | null;
};
export type NodeDetailTokenUsage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costUsd: number | null;
    eventCount: number;
    models: string[];
    agents: string[];
};
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
export type AggregateNodeDetailParams = {
    runId: string;
    nodeId: string;
    iteration?: number;
};
export type RenderNodeDetailOptions = {
    expandAttempts: boolean;
    expandTools: boolean;
};
export declare function aggregateNodeDetailEffect(adapter: SmithersDb, params: AggregateNodeDetailParams): Effect.Effect<EnrichedNodeDetail, SmithersError>;
export declare function renderNodeDetailHuman(detail: EnrichedNodeDetail, options: RenderNodeDetailOptions): string;
export {};
