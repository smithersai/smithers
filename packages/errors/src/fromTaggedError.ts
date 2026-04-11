import { SmithersError } from "./SmithersError.ts";

type TaggedErrorPayload = {
  readonly _tag?: unknown;
  readonly message?: unknown;
  readonly details?: unknown;
  readonly nodeId?: unknown;
  readonly iteration?: unknown;
  readonly attempt?: unknown;
  readonly timeoutMs?: unknown;
  readonly staleForMs?: unknown;
  readonly lastHeartbeatAtMs?: unknown;
  readonly runId?: unknown;
  readonly status?: unknown;
  readonly name?: unknown;
};

function objectPayload(value: unknown): TaggedErrorPayload | undefined {
  return value && typeof value === "object"
    ? (value as TaggedErrorPayload)
    : undefined;
}

export function fromTaggedError(error: unknown): SmithersError | undefined {
  const payload = objectPayload(error);
  if (!payload || typeof payload._tag !== "string") return undefined;
  const message =
    typeof payload.message === "string" ? payload.message : String(payload._tag);
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { readonly cause?: unknown }).cause
      : undefined;
  const details =
    payload.details && typeof payload.details === "object" && !Array.isArray(payload.details)
      ? (payload.details as Record<string, unknown>)
      : undefined;

  switch (payload._tag) {
    case "TaskAborted":
      return new SmithersError("TASK_ABORTED", message, details, {
        cause,
        name: typeof payload.name === "string" ? payload.name : undefined,
      });
    case "TaskTimeout":
      return new SmithersError(
        "TASK_TIMEOUT",
        message,
        {
          nodeId: payload.nodeId,
          attempt: payload.attempt,
          timeoutMs: payload.timeoutMs,
        },
        { cause },
      );
    case "TaskHeartbeatTimeout":
      return new SmithersError(
        "TASK_HEARTBEAT_TIMEOUT",
        message,
        {
          nodeId: payload.nodeId,
          iteration: payload.iteration,
          attempt: payload.attempt,
          timeoutMs: payload.timeoutMs,
          staleForMs: payload.staleForMs,
          lastHeartbeatAtMs: payload.lastHeartbeatAtMs,
        },
        { cause },
      );
    case "RunNotFound":
      return new SmithersError("RUN_NOT_FOUND", message, { runId: payload.runId }, { cause });
    case "InvalidInput":
      return new SmithersError("INVALID_INPUT", message, details, { cause });
    case "DbWriteFailed":
      return new SmithersError("DB_WRITE_FAILED", message, details, { cause });
    case "AgentCliError":
      return new SmithersError("AGENT_CLI_ERROR", message, details, { cause });
    case "WorkflowFailed":
      return new SmithersError(
        "WORKFLOW_EXECUTION_FAILED",
        message,
        {
          ...details,
          ...(payload.status === undefined ? {} : { status: payload.status }),
        },
        { cause },
      );
    default:
      return undefined;
  }
}
