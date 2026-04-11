import type { AgentCliStartedEvent } from "./AgentCliStartedEvent";
import type { AgentCliActionEvent } from "./AgentCliActionEvent";
import type { AgentCliCompletedEvent } from "./AgentCliCompletedEvent";

export type AgentCliEvent =
  | AgentCliStartedEvent
  | AgentCliActionEvent
  | AgentCliCompletedEvent;
