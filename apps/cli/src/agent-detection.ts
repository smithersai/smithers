export type AgentAvailabilityStatus = "likely-subscription" | "api-key" | "binary-only" | "unavailable";
export type AgentAvailability = {
    id: "claude" | "codex" | "gemini" | "pi" | "kimi" | "amp";
    binary: string;
    hasBinary: boolean;
    hasAuthSignal: boolean;
    hasApiKeySignal: boolean;
    status: AgentAvailabilityStatus;
    score: number;
    usable: boolean;
    checks: string[];
};
export declare function detectAvailableAgents(env?: NodeJS.ProcessEnv): AgentAvailability[];
export declare function generateAgentsTs(env?: NodeJS.ProcessEnv): string;
