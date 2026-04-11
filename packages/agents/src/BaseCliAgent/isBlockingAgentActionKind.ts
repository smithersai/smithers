import type { AgentCliActionKind } from "./AgentCliActionKind";

export function isBlockingAgentActionKind(kind: AgentCliActionKind): boolean {
  return kind === "command" || kind === "tool" || kind === "web_search";
}
