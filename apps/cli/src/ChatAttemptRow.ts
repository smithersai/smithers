export type ChatAttemptRow = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    state: string;
    startedAtMs: number;
    finishedAtMs?: number | null;
    cached?: boolean | null;
    metaJson?: string | null;
    responseText?: string | null;
};
