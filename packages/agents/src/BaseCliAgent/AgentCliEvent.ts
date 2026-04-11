import type { AgentCliActionKind } from "./AgentCliActionKind";

export type AgentCliActionPhase = "started" | "updated" | "completed";

export type AgentCliEventLevel = "debug" | "info" | "warning" | "error";

export type AgentCliStartedEvent = {
  type: "started";
  engine: string;
  title: string;
  resume?: string;
  detail?: Record<string, unknown>;
};

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

export type AgentCliCompletedEvent = {
  type: "completed";
  engine: string;
  ok: boolean;
  answer?: string;
  error?: string;
  resume?: string;
  usage?: Record<string, unknown>;
};

export type AgentCliEvent =
  | AgentCliStartedEvent
  | AgentCliActionEvent
  | AgentCliCompletedEvent;
