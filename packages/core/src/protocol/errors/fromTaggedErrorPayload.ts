import type { SmithersTaggedError } from "./SmithersTaggedError";
import type { SmithersTaggedErrorPayload } from "./SmithersTaggedErrorPayload";
import { TaskAborted } from "./TaskAborted";
import { TaskTimeout } from "./TaskTimeout";
import { TaskHeartbeatTimeout } from "./TaskHeartbeatTimeout";
import { RunNotFound } from "./RunNotFound";
import { InvalidInput } from "./InvalidInput";
import { DbWriteFailed } from "./DbWriteFailed";
import { AgentCliError } from "./AgentCliError";
import { WorkflowFailed } from "./WorkflowFailed";

export function fromTaggedErrorPayload(
  payload: SmithersTaggedErrorPayload,
): SmithersTaggedError {
  switch (payload._tag) {
    case "TaskAborted":
      return new TaskAborted({
        message: payload.message,
        details: payload.details,
        name: payload.name,
      });
    case "TaskTimeout":
      return new TaskTimeout({
        message: payload.message,
        nodeId: payload.nodeId,
        attempt: payload.attempt,
        timeoutMs: payload.timeoutMs,
      });
    case "TaskHeartbeatTimeout":
      return new TaskHeartbeatTimeout({
        message: payload.message,
        nodeId: payload.nodeId,
        iteration: payload.iteration,
        attempt: payload.attempt,
        timeoutMs: payload.timeoutMs,
        staleForMs: payload.staleForMs,
        lastHeartbeatAtMs: payload.lastHeartbeatAtMs,
      });
    case "RunNotFound":
      return new RunNotFound({
        message: payload.message,
        runId: payload.runId,
      });
    case "InvalidInput":
      return new InvalidInput({
        message: payload.message,
        details: payload.details,
      });
    case "DbWriteFailed":
      return new DbWriteFailed({
        message: payload.message,
        details: payload.details,
      });
    case "AgentCliError":
      return new AgentCliError({
        message: payload.message,
        details: payload.details,
      });
    case "WorkflowFailed":
      return new WorkflowFailed({
        message: payload.message,
        details: payload.details,
        status: payload.status,
      });
  }
}
