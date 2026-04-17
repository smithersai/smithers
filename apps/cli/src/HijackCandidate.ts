export type HijackCandidate = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    mode: "native-cli" | "conversation";
    resume?: string;
    messages?: unknown[];
    cwd: string;
};
