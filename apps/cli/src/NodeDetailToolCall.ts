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
