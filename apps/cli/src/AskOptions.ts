import type { SmithersToolSurface } from "@smithers-orchestrator/agents/agent-contract";

export type AskAgentId = "claude" | "codex" | "kimi" | "gemini" | "pi";

export type AskOptions = {
    agent?: AskAgentId;
    listAgents?: boolean;
    dumpPrompt?: boolean;
    toolSurface?: SmithersToolSurface;
    noMcp?: boolean;
    printBootstrap?: boolean;
};
