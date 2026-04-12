import { type SmithersToolSurface } from "@smithers/agents/agent-contract";
declare const ASK_AGENT_IDS: readonly ["claude", "codex", "kimi", "gemini", "pi"];
type AskAgentId = typeof ASK_AGENT_IDS[number];
type AskOptions = {
    agent?: AskAgentId;
    listAgents?: boolean;
    dumpPrompt?: boolean;
    toolSurface?: SmithersToolSurface;
    noMcp?: boolean;
    printBootstrap?: boolean;
};
export declare function ask(question: string | undefined, cwd: string, options?: AskOptions): Promise<void>;
export {};
