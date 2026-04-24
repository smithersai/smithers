import { type CliOutputInterpreter, BaseCliAgent } from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";
import { type AgentCapabilityRegistry } from "./capability-registry";

export type OpenCodeAgentOptions = BaseCliAgentOptions & {
  /** Model identifier (e.g., "anthropic/claude-opus-4-20250514", "openai/gpt-5.4") */
  model?: string;
  /** OpenCode agent name (maps to --agent flag, selects predefined agent config) */
  agentName?: string;
  /** Files to attach to the prompt via -f flags */
  attachFiles?: string[];
  /** Continue a previous session */
  continueSession?: boolean;
  /** Resume a specific session by ID */
  sessionId?: string;
  /** Variant/reasoning effort level */
  variant?: "high" | "medium" | "low";
};

export declare function createOpenCodeCapabilityRegistry(
  opts?: OpenCodeAgentOptions
): AgentCapabilityRegistry;

export declare class OpenCodeAgent extends BaseCliAgent {
  private readonly opts: OpenCodeAgentOptions;
  readonly capabilities: AgentCapabilityRegistry;
  readonly cliEngine: "opencode";
  constructor(opts?: OpenCodeAgentOptions);
  createOutputInterpreter(): CliOutputInterpreter;
  buildCommand(params: {
    prompt: string;
    systemPrompt?: string;
    cwd: string;
    options: any;
  }): Promise<{
    command: string;
    args: string[];
    outputFormat: "stream-json";
    env?: Record<string, string>;
    stdoutBannerPatterns: RegExp[];
    stdoutErrorPatterns: RegExp[];
  }>;
}
