import { Data } from "effect";

type TaggedErrorDetails = Record<string, unknown>;

type GenericTaggedErrorArgs = {
  readonly message: string;
  readonly details?: TaggedErrorDetails;
};

export class TaskAborted extends Data.TaggedError("TaskAborted")<{
  readonly message: string;
  readonly details?: TaggedErrorDetails;
  readonly name?: string;
}> {}

export class TaskTimeout extends Data.TaggedError("TaskTimeout")<{
  readonly message: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly timeoutMs: number;
}> {}

export class TaskHeartbeatTimeout extends Data.TaggedError(
  "TaskHeartbeatTimeout",
)<{
  readonly message: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly staleForMs: number;
  readonly lastHeartbeatAtMs: number;
}> {}

export class RunNotFound extends Data.TaggedError("RunNotFound")<{
  readonly message: string;
  readonly runId: string;
}> {}

export class InvalidInput extends Data.TaggedError("InvalidInput")<
  GenericTaggedErrorArgs
> {}

export class DbWriteFailed extends Data.TaggedError("DbWriteFailed")<
  GenericTaggedErrorArgs
> {}

export class AgentCliError extends Data.TaggedError("AgentCliError")<
  GenericTaggedErrorArgs
> {}

export class WorkflowFailed extends Data.TaggedError("WorkflowFailed")<
  GenericTaggedErrorArgs & {
    readonly status?: number;
  }
> {}

export type SmithersTaggedError =
  | TaskAborted
  | TaskTimeout
  | TaskHeartbeatTimeout
  | RunNotFound
  | InvalidInput
  | DbWriteFailed
  | AgentCliError
  | WorkflowFailed;

export const smithersTaggedErrorCodes = {
  TaskAborted: "TASK_ABORTED",
  TaskTimeout: "TASK_TIMEOUT",
  TaskHeartbeatTimeout: "TASK_HEARTBEAT_TIMEOUT",
  RunNotFound: "RUN_NOT_FOUND",
  InvalidInput: "INVALID_INPUT",
  DbWriteFailed: "DB_WRITE_FAILED",
  AgentCliError: "AGENT_CLI_ERROR",
  WorkflowFailed: "WORKFLOW_EXECUTION_FAILED",
} as const;

export type SmithersTaggedErrorTag = keyof typeof smithersTaggedErrorCodes;

export type SmithersTaggedErrorPayload =
  | {
      readonly _tag: "TaskAborted";
      readonly message: string;
      readonly details?: TaggedErrorDetails;
      readonly name?: string;
    }
  | {
      readonly _tag: "TaskTimeout";
      readonly message: string;
      readonly nodeId: string;
      readonly attempt: number;
      readonly timeoutMs: number;
    }
  | {
      readonly _tag: "TaskHeartbeatTimeout";
      readonly message: string;
      readonly nodeId: string;
      readonly iteration: number;
      readonly attempt: number;
      readonly timeoutMs: number;
      readonly staleForMs: number;
      readonly lastHeartbeatAtMs: number;
    }
  | {
      readonly _tag: "RunNotFound";
      readonly message: string;
      readonly runId: string;
    }
  | {
      readonly _tag: "InvalidInput";
      readonly message: string;
      readonly details?: TaggedErrorDetails;
    }
  | {
      readonly _tag: "DbWriteFailed";
      readonly message: string;
      readonly details?: TaggedErrorDetails;
    }
  | {
      readonly _tag: "AgentCliError";
      readonly message: string;
      readonly details?: TaggedErrorDetails;
    }
  | {
      readonly _tag: "WorkflowFailed";
      readonly message: string;
      readonly details?: TaggedErrorDetails;
      readonly status?: number;
    };

function isRecord(value: unknown): value is TaggedErrorDetails {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isSmithersTaggedErrorTag(
  value: unknown,
): value is SmithersTaggedErrorTag {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(smithersTaggedErrorCodes, value)
  );
}

export function isSmithersTaggedError(
  value: unknown,
): value is SmithersTaggedError {
  return Boolean(
    value &&
      typeof value === "object" &&
      isSmithersTaggedErrorTag((value as any)._tag),
  );
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
