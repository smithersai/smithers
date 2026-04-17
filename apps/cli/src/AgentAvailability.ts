import type { AgentAvailabilityStatus } from "./AgentAvailabilityStatus.ts";

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
