import type { TaggedErrorDetails } from "./TaggedErrorDetails";
import type { SmithersTaggedErrorPayload } from "./SmithersTaggedErrorPayload";
import { isSmithersTaggedError } from "./isSmithersTaggedError";

function isRecord(value: unknown): value is TaggedErrorDetails {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function toTaggedErrorPayload(
  error: unknown,
): SmithersTaggedErrorPayload | undefined {
  if (!isSmithersTaggedError(error)) {
    return undefined;
  }

  switch (error._tag) {
    case "TaskAborted":
      return {
        _tag: "TaskAborted",
        message: String(error.message),
        details: isRecord((error as any).details)
          ? ((error as any).details as TaggedErrorDetails)
          : undefined,
        name: typeof (error as any).name === "string" ? (error as any).name : undefined,
      };
    case "TaskTimeout":
      return {
        _tag: "TaskTimeout",
        message: String(error.message),
        nodeId: String((error as any).nodeId),
        attempt: Number((error as any).attempt),
        timeoutMs: Number((error as any).timeoutMs),
      };
    case "TaskHeartbeatTimeout":
      return {
        _tag: "TaskHeartbeatTimeout",
        message: String(error.message),
        nodeId: String((error as any).nodeId),
        iteration: Number((error as any).iteration),
        attempt: Number((error as any).attempt),
        timeoutMs: Number((error as any).timeoutMs),
        staleForMs: Number((error as any).staleForMs),
        lastHeartbeatAtMs: Number((error as any).lastHeartbeatAtMs),
      };
    case "RunNotFound":
      return {
        _tag: "RunNotFound",
        message: String(error.message),
        runId: String((error as any).runId),
      };
    case "InvalidInput":
      return {
        _tag: "InvalidInput",
        message: String(error.message),
        details: isRecord((error as any).details)
          ? ((error as any).details as TaggedErrorDetails)
          : undefined,
      };
    case "DbWriteFailed":
      return {
        _tag: "DbWriteFailed",
        message: String(error.message),
        details: isRecord((error as any).details)
          ? ((error as any).details as TaggedErrorDetails)
          : undefined,
      };
    case "AgentCliError":
      return {
        _tag: "AgentCliError",
        message: String(error.message),
        details: isRecord((error as any).details)
          ? ((error as any).details as TaggedErrorDetails)
          : undefined,
      };
    case "WorkflowFailed":
      return {
        _tag: "WorkflowFailed",
        message: String(error.message),
        details: isRecord((error as any).details)
          ? ((error as any).details as TaggedErrorDetails)
          : undefined,
        status:
          typeof (error as any).status === "number"
            ? (error as any).status
            : undefined,
      };
  }
}
