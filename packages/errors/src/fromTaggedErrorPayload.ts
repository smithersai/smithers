import type { SmithersTaggedError } from "./SmithersTaggedError.ts";
import type { SmithersTaggedErrorPayload } from "./SmithersTaggedErrorPayload.ts";
import { TaskAborted } from "./TaskAborted.ts";
import { TaskTimeout } from "./TaskTimeout.ts";
import { TaskHeartbeatTimeout } from "./TaskHeartbeatTimeout.ts";
import { RunNotFound } from "./RunNotFound.ts";
import { InvalidInput } from "./InvalidInput.ts";
import { DbWriteFailed } from "./DbWriteFailed.ts";
import { AgentCliError } from "./AgentCliError.ts";
import { WorkflowFailed } from "./WorkflowFailed.ts";

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
