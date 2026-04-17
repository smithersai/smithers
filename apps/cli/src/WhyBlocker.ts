import type { WhyBlockerKind } from "./WhyBlockerKind.ts";

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
