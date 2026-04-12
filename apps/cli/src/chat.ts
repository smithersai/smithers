export type ChatAttemptMeta = {
    kind?: string | null;
    prompt?: string | null;
    label?: string | null;
    agentId?: string | null;
    agentModel?: string | null;
};
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
export type ChatOutputEvent = {
    seq: number;
    timestampMs: number;
    type: string;
    payloadJson: string;
};
export type ParsedNodeOutputEvent = {
    seq: number;
    timestampMs: number;
    nodeId: string;
    iteration: number;
    attempt: number;
    stream: "stdout" | "stderr";
    text: string;
};
export declare function parseChatAttemptMeta(metaJson?: string | null): ChatAttemptMeta;
export declare function chatAttemptKey(attempt: Pick<ChatAttemptRow, "nodeId" | "iteration" | "attempt">): string;
export declare function parseNodeOutputEvent(event: ChatOutputEvent): ParsedNodeOutputEvent | null;
export declare function isAgentAttempt(attempt: ChatAttemptRow, outputAttemptKeys: ReadonlySet<string>): boolean;
export declare function selectChatAttempts(attempts: ChatAttemptRow[], outputAttemptKeys: ReadonlySet<string>, includeAll: boolean): ChatAttemptRow[];
export declare function formatChatAttemptHeader(attempt: ChatAttemptRow): string;
export declare function formatChatBlock(options: {
    baseMs: number;
    timestampMs: number;
    role: "user" | "assistant" | "stderr";
    attempt: Pick<ChatAttemptRow, "nodeId" | "iteration" | "attempt">;
    text: string;
}): string;
