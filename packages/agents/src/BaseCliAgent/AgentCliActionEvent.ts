import type { AgentCliActionKind } from "./AgentCliActionKind";
import type { AgentCliActionPhase } from "./AgentCliActionPhase";
import type { AgentCliEventLevel } from "./AgentCliEventLevel";

export type AgentCliActionEvent = {
  type: "action";
  engine: string;
  phase: AgentCliActionPhase;
  entryType?: "thought" | "message";
  action: {
    id: string;
    kind: AgentCliActionKind;
    title: string;
    detail?: Record<string, unknown>;
  };
  message?: string;
  ok?: boolean;
  level?: AgentCliEventLevel;
};
