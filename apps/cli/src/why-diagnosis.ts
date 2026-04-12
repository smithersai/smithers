import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors";
export type WhyBlockerKind = "waiting-approval" | "waiting-event" | "waiting-timer" | "stale-task-heartbeat" | "retry-backoff" | "retries-exhausted" | "stale-heartbeat" | "dependency-failed";
export type WhyBlocker = {
    kind: WhyBlockerKind;
    nodeId: string;
    iteration: number | null;
    reason: string;
    waitingSince: number;
    unblocker: string;
    context?: string;
    signalName?: string | null;
    dependencyNodeId?: string | null;
    firesAtMs?: number | null;
    remainingMs?: number | null;
    attempt?: number | null;
    maxAttempts?: number | null;
};
export type WhyDiagnosis = {
    runId: string;
    status: string;
    summary: string;
    generatedAtMs: number;
    blockers: WhyBlocker[];
    currentNodeId: string | null;
};
export declare function diagnoseRunEffect(adapter: SmithersDb, runId: string, nowMs?: number): Effect.Effect<WhyDiagnosis, SmithersError>;
export declare function renderWhyDiagnosisHuman(diagnosis: WhyDiagnosis): string;
export declare function diagnosisCtaCommands(diagnosis: WhyDiagnosis): Array<{
    command: string;
    description: string;
}>;
