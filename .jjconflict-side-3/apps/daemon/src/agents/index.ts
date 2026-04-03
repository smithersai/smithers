import type { AgentCli } from "@burns/shared"

import { ClaudeCodeAgent } from "@/agents/ClaudeCodeAgent"
import { CodexAgent } from "@/agents/CodexAgent"
import { GeminiAgent } from "@/agents/GeminiAgent"
import { PiAgent } from "@/agents/PiAgent"
import { HttpError } from "@/utils/http-error"

export const supportedAgentClis = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    logoProvider: "anthropic",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    logoProvider: "openai",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    logoProvider: "google",
  },
  {
    id: "pi",
    name: "Pi",
    command: "pi",
    logoProvider: "google",
  },
] as const satisfies ReadonlyArray<Omit<AgentCli, "binaryPath">>

export function getSupportedAgentCliById(agentId: string) {
  return supportedAgentClis.find((agent) => agent.id === agentId) ?? null
}

export function createCliAgent(
  agentId: string,
  options: { systemPrompt?: string; env?: Record<string, string | undefined> } = {}
) {
  switch (agentId) {
    case "claude-code":
      return new ClaudeCodeAgent(options)
    case "codex":
      return new CodexAgent(options)
    case "gemini":
      return new GeminiAgent(options)
    case "pi":
      return new PiAgent(options)
    default:
      throw new HttpError(400, `Unsupported agent CLI: ${agentId}`)
  }
}
