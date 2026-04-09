import {
  smithersTaggedErrorCodes,
  toTaggedErrorPayload,
} from "../errors/tagged";

export const ERROR_REFERENCE_URL = "https://smithers.sh/reference/errors";

export type SmithersErrorCategory =
  | "engine"
  | "components"
  | "tools"
  | "agents"
  | "database"
  | "effect"
  | "hot"
  | "scorers"
  | "cli"
  | "integrations";

export type SmithersErrorDefinition = {
  category: SmithersErrorCategory;
  when: string;
  details?: string;
};

export const smithersErrorDefinitions = {
  INVALID_INPUT: {
    category: "engine",
    when: "Workflow input fails validation or the runtime receives a non-object input payload.",
  },
  MISSING_INPUT: {
    category: "engine",
    when: "A resume run references an input row that is missing from the database.",
  },
  MISSING_INPUT_TABLE: {
    category: "engine",
    when: "The workflow schema does not expose the expected input table during resume or hydration.",
  },
  RESUME_METADATA_MISMATCH: {
    category: "engine",
    when: "Stored run metadata no longer matches the workflow being resumed.",
  },
  UNKNOWN_OUTPUT_SCHEMA: {
    category: "engine",
    when: "A task references an output table that is not present in the schema registry.",
  },
  INVALID_OUTPUT: {
    category: "engine",
    when: "Agent output cannot be parsed or validated against the declared output schema.",
  },
  WORKTREE_CREATE_FAILED: {
    category: "engine",
    when: "Smithers fails to create or hydrate a git or jj worktree for a task.",
    details: "{ worktreePath, vcsType, branch? }",
  },
  VCS_NOT_FOUND: {
    category: "engine",
    when: "No supported git or jj repository root can be found for the workflow.",
    details: "{ rootDir }",
  },
  SNAPSHOT_NOT_FOUND: {
    category: "engine",
    when: "A requested time-travel snapshot or frame does not exist.",
    details: "{ runId, frameNo }",
  },
  VCS_WORKSPACE_CREATE_FAILED: {
    category: "engine",
    when: "Smithers fails to materialize a jj workspace for time-travel or replay.",
    details: "{ runId, frameNo, vcsPointer, workspacePath }",
  },
  TASK_TIMEOUT: {
    category: "engine",
    when: "A task compute callback exceeds its configured timeout.",
    details: "{ nodeId, attempt, timeoutMs }",
  },
  RUN_NOT_FOUND: {
    category: "engine",
    when: "A CLI or engine command references a run ID that does not exist in the database.",
    details: "{ runId }",
  },
  NODE_NOT_FOUND: {
    category: "engine",
    when: "A CLI command references a node ID that does not exist for the given run.",
    details: "{ runId, nodeId }",
  },
  INVALID_EVENTS_OPTIONS: {
    category: "cli",
    when: "The smithers events command receives invalid filter options.",
    details: "{}",
  },
  SANDBOX_BUNDLE_INVALID: {
    category: "engine",
    when: "A sandbox bundle fails validation (missing README, invalid manifest, etc.).",
    details: "{ bundlePath }",
  },
  SANDBOX_BUNDLE_TOO_LARGE: {
    category: "engine",
    when: "A sandbox bundle exceeds the maximum allowed size.",
    details: "{ bundlePath, maxBytes }",
  },
  WORKFLOW_EXECUTION_FAILED: {
    category: "engine",
    when: "A child or builder workflow exits unsuccessfully without surfacing a typed error payload.",
    details: "{ status }",
  },
  SANDBOX_EXECUTION_FAILED: {
    category: "engine",
    when: "Sandbox setup or execution fails before a more specific sandbox error can be emitted.",
    details: "{ sandboxId, runId?, maxConcurrent?, activeSandboxCount? }",
  },
  TASK_HEARTBEAT_TIMEOUT: {
    category: "engine",
    when: "A task heartbeat timeout is exceeded while the task is still in progress.",
    details: "{ nodeId, iteration, attempt, timeoutMs, staleForMs }",
  },
  HEARTBEAT_PAYLOAD_TOO_LARGE: {
    category: "engine",
    when: "A task heartbeat payload exceeds the maximum persisted checkpoint size.",
    details: "{ dataSizeBytes, maxBytes }",
  },
  HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE: {
    category: "engine",
    when: "A task heartbeat payload contains values that cannot be serialized to JSON.",
    details: "{ path, valueType? }",
  },
  TASK_ABORTED: {
    category: "engine",
    when: "A running task is aborted through an AbortSignal or shutdown path.",
  },

  TASK_ID_REQUIRED: {
    category: "components",
    when: "<Task> is missing a valid string id.",
  },
  TASK_MISSING_OUTPUT: {
    category: "components",
    when: "<Task> is missing its output prop.",
    details: "{ nodeId }",
  },
  DUPLICATE_ID: {
    category: "components",
    when: "Two nodes with the same runtime id are mounted in one workflow graph.",
    details: "{ kind, id }",
  },
  NESTED_LOOP: {
    category: "components",
    when: "<Loop> or <Ralph> is nested inside another loop construct that Smithers does not support.",
  },
  WORKTREE_EMPTY_PATH: {
    category: "components",
    when: "<Worktree> is mounted with an empty path.",
  },
  MDX_PRELOAD_INACTIVE: {
    category: "components",
    when: "A prompt object is rendered without the MDX preload layer being active.",
  },
  CONTEXT_OUTSIDE_WORKFLOW: {
    category: "components",
    when: "Workflow context access happens outside an active Smithers workflow render.",
  },
  MISSING_OUTPUT: {
    category: "components",
    when: "Code calls ctx.output() for a node result that does not exist.",
    details: "{ nodeId, iteration }",
  },
  DEP_NOT_SATISFIED: {
    category: "components",
    when: "A typed dep on <Task> references an upstream output that has not been produced yet.",
    details: "{ taskId, depKey, resolvedNodeId }",
  },
  ASPECT_BUDGET_EXCEEDED: {
    category: "components",
    when: "An Aspects budget (tokens, latency, or cost) has been exceeded.",
    details: "{ kind, limit, current }",
  },
  APPROVAL_OUTSIDE_TASK: {
    category: "components",
    when: "<Approval> is resolved outside the active task runtime.",
  },
  WORKFLOW_MISSING_DEFAULT: {
    category: "components",
    when: "A workflow module does not export a default Smithers workflow.",
  },

  TOOL_PATH_INVALID: {
    category: "tools",
    when: "A filesystem tool receives a non-string path.",
  },
  TOOL_PATH_ESCAPE: {
    category: "tools",
    when: "A filesystem tool resolves a path outside the sandbox root, including through symlinks.",
  },
  TOOL_FILE_TOO_LARGE: {
    category: "tools",
    when: "A read or edit operation exceeds the configured file size limit.",
  },
  TOOL_CONTENT_TOO_LARGE: {
    category: "tools",
    when: "A write operation exceeds the configured content size limit.",
  },
  TOOL_PATCH_TOO_LARGE: {
    category: "tools",
    when: "An edit patch exceeds the configured patch size limit.",
  },
  TOOL_PATCH_FAILED: {
    category: "tools",
    when: "A unified diff patch cannot be applied to the target file.",
  },
  TOOL_NETWORK_DISABLED: {
    category: "tools",
    when: "The bash tool tries to access the network while network access is disabled.",
  },
  TOOL_GIT_REMOTE_DISABLED: {
    category: "tools",
    when: "The bash tool attempts a remote git operation while network access is disabled.",
  },
  TOOL_COMMAND_FAILED: {
    category: "tools",
    when: "A bash tool command exits with a non-zero status.",
  },
  TOOL_GREP_FAILED: {
    category: "tools",
    when: "The grep tool fails with an rg execution error.",
  },

  AGENT_CLI_ERROR: {
    category: "agents",
    when: "A CLI-backed agent exits unsuccessfully, streams an explicit error, or its RPC transport fails.",
  },
  AGENT_RPC_FILE_ARGS: {
    category: "agents",
    when: "Pi RPC mode is used with file arguments that the transport does not support.",
  },
  AGENT_BUILD_COMMAND: {
    category: "agents",
    when: "An agent implementation forbids buildCommand() because it uses a custom generate() transport.",
  },
  AGENT_DIAGNOSTIC_TIMEOUT: {
    category: "agents",
    when: "An internal agent diagnostic check exceeds the per-check timeout budget.",
  },

  DB_MISSING_COLUMNS: {
    category: "database",
    when: "A table used by Smithers does not expose required columns such as runId or nodeId.",
  },
  DB_REQUIRES_BUN_SQLITE: {
    category: "database",
    when: "The database adapter is not backed by a Bun SQLite client with exec().",
  },
  DB_QUERY_FAILED: {
    category: "database",
    when: "A database read query throws or rejects while running inside an Effect.",
  },
  DB_WRITE_FAILED: {
    category: "database",
    when: "A database write or migration fails, including after SQLite retry exhaustion.",
  },

  INTERNAL_ERROR: {
    category: "effect",
    when: "An unexpected internal exception crossed an Effect boundary without a more specific Smithers code.",
  },
  PROCESS_ABORTED: {
    category: "effect",
    when: "A spawned child process is aborted by signal or shutdown.",
    details: "{ command, args, cwd }",
  },
  PROCESS_TIMEOUT: {
    category: "effect",
    when: "A spawned child process exceeds its total timeout.",
    details: "{ command, args, cwd, timeoutMs }",
  },
  PROCESS_IDLE_TIMEOUT: {
    category: "effect",
    when: "A spawned child process stops producing output longer than its idle timeout.",
    details: "{ command, args, cwd, idleTimeoutMs }",
  },
  PROCESS_SPAWN_FAILED: {
    category: "effect",
    when: "The runtime cannot spawn the requested child process.",
    details: "{ command, args, cwd }",
  },
  TASK_RUNTIME_UNAVAILABLE: {
    category: "effect",
    when: "Builder task runtime APIs are accessed outside an executing step.",
  },

  SCHEMA_CHANGE_HOT: {
    category: "hot",
    when: "Hot reload detects a schema change that requires a full restart.",
  },
  HOT_OVERLAY_FAILED: {
    category: "hot",
    when: "Building or cleaning the generated hot-reload overlay fails.",
  },
  HOT_RELOAD_INVALID_MODULE: {
    category: "hot",
    when: "A hot-reloaded workflow module does not export a valid default workflow build.",
  },

  SCORER_FAILED: {
    category: "scorers",
    when: "A scorer throws or rejects while Smithers is evaluating a result.",
  },

  WORKFLOW_EXISTS: {
    category: "cli",
    when: "The workflow creation CLI refuses to overwrite an existing workflow file.",
  },
  CLI_DB_NOT_FOUND: {
    category: "cli",
    when: "A CLI command cannot find a nearby smithers.db file.",
  },
  CLI_AGENT_UNSUPPORTED: {
    category: "cli",
    when: "The ask command selects an agent integration that Smithers does not support in that mode.",
  },

  PI_HTTP_ERROR: {
    category: "integrations",
    when: "The Pi or server integration receives a non-success HTTP response from Smithers.",
  },
  EXTERNAL_BUILD_FAILED: {
    category: "integrations",
    when: "An external workflow host fails to build a Smithers HostNode payload.",
    details: "{ scriptPath, error?, exitCode?, stderr?, stdout? }",
  },
  SCHEMA_DISCOVERY_FAILED: {
    category: "integrations",
    when: "External workflow schema discovery fails or returns invalid output.",
    details: "{ scriptPath, error?, exitCode?, stderr? }",
  },

  OPENAPI_SPEC_LOAD_FAILED: {
    category: "integrations",
    when: "An OpenAPI spec cannot be loaded or parsed.",
  },
  OPENAPI_OPERATION_NOT_FOUND: {
    category: "integrations",
    when: "The requested operationId does not exist in the OpenAPI spec.",
  },
  OPENAPI_TOOL_EXECUTION_FAILED: {
    category: "integrations",
    when: "An OpenAPI tool call fails during HTTP execution.",
  },
} as const satisfies Record<string, SmithersErrorDefinition>;

export type KnownSmithersErrorCode = keyof typeof smithersErrorDefinitions;
export type SmithersErrorCode =
  | KnownSmithersErrorCode
  | (string & {});

export const knownSmithersErrorCodes = Object.keys(
  smithersErrorDefinitions,
) as KnownSmithersErrorCode[];

export function isKnownSmithersErrorCode(
  code: string,
): code is KnownSmithersErrorCode {
  return code in smithersErrorDefinitions;
}

export function getSmithersErrorDefinition(
  code: SmithersErrorCode,
): SmithersErrorDefinition | undefined {
  if (!isKnownSmithersErrorCode(code)) return undefined;
  return smithersErrorDefinitions[code];
}

export function getSmithersErrorDocsUrl(_code: SmithersErrorCode): string {
  return ERROR_REFERENCE_URL;
}

function formatSmithersErrorMessage(message: string, docsUrl: string): string {
  if (message.includes(docsUrl)) return message;
  return `${message} See ${docsUrl}`;
}

export type SmithersErrorOptions = {
  cause?: unknown;
  includeDocsUrl?: boolean;
  name?: string;
};

export class SmithersError extends Error {
  code: SmithersErrorCode;
  summary: string;
  docsUrl: string;
  details?: Record<string, unknown>;
  override cause?: unknown;

  constructor(
    code: SmithersErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options: SmithersErrorOptions = {},
  ) {
    const docsUrl = getSmithersErrorDocsUrl(code);
    super(
      options.includeDocsUrl === false
        ? message
        : formatSmithersErrorMessage(message, docsUrl),
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = options.name ?? "SmithersError";
    this.code = code;
    this.summary = message;
    this.docsUrl = docsUrl;
    this.details = details;
    this.cause = options.cause;
  }
}

export function fromTaggedError(error: unknown): SmithersError | undefined {
  const payload = toTaggedErrorPayload(error);
  if (!payload) {
    return undefined;
  }

  switch (payload._tag) {
    case "TaskAborted":
      return new SmithersError(
        smithersTaggedErrorCodes.TaskAborted,
        payload.message,
        payload.details,
        {
          cause:
            error && typeof error === "object" && "cause" in (error as any)
              ? (error as any).cause
              : undefined,
          name: payload.name,
        },
      );
    case "TaskTimeout":
      return new SmithersError(
        smithersTaggedErrorCodes.TaskTimeout,
        payload.message,
        {
          nodeId: payload.nodeId,
          attempt: payload.attempt,
          timeoutMs: payload.timeoutMs,
        },
        {
          cause:
            error && typeof error === "object" && "cause" in (error as any)
              ? (error as any).cause
              : undefined,
        },
      );
    case "TaskHeartbeatTimeout":
      return new SmithersError(
        smithersTaggedErrorCodes.TaskHeartbeatTimeout,
        payload.message,
        {
          nodeId: payload.nodeId,
          iteration: payload.iteration,
          attempt: payload.attempt,
          timeoutMs: payload.timeoutMs,
          staleForMs: payload.staleForMs,
          lastHeartbeatAtMs: payload.lastHeartbeatAtMs,
        },
        {
          cause:
            error && typeof error === "object" && "cause" in (error as any)
              ? (error as any).cause
              : undefined,
        },
      );
    case "RunNotFound":
      return new SmithersError(
        smithersTaggedErrorCodes.RunNotFound,
        payload.message,
        { runId: payload.runId },
        {
          cause:
            error && typeof error === "object" && "cause" in (error as any)
              ? (error as any).cause
              : undefined,
        },
      );
    case "InvalidInput":
      return new SmithersError(
        smithersTaggedErrorCodes.InvalidInput,
        payload.message,
        payload.details,
        {
          cause:
            error && typeof error === "object" && "cause" in (error as any)
              ? (error as any).cause
              : undefined,
        },
      );
    case "DbWriteFailed":
      return new SmithersError(
        smithersTaggedErrorCodes.DbWriteFailed,
        payload.message,
        payload.details,
        {
          cause:
            error && typeof error === "object" && "cause" in (error as any)
              ? (error as any).cause
              : undefined,
        },
      );
    case "AgentCliError":
      return new SmithersError(
        smithersTaggedErrorCodes.AgentCliError,
        payload.message,
        payload.details,
        {
          cause:
            error && typeof error === "object" && "cause" in (error as any)
              ? (error as any).cause
              : undefined,
        },
      );
    case "WorkflowFailed":
      return new SmithersError(
        smithersTaggedErrorCodes.WorkflowFailed,
        payload.message,
        {
          ...(payload.details ?? {}),
          ...(payload.status === undefined ? {} : { status: payload.status }),
        },
        {
          cause:
            error && typeof error === "object" && "cause" in (error as any)
              ? (error as any).cause
              : undefined,
        },
      );
  }
}

export type SmithersErrorWrapOptions = {
  code?: SmithersErrorCode;
  details?: Record<string, unknown>;
};

export function toSmithersError(
  cause: unknown,
  label?: string,
  options: SmithersErrorWrapOptions = {},
): SmithersError {
  const taggedError = fromTaggedError(cause);
  const normalizedCause = taggedError ?? cause;

  if (
    normalizedCause instanceof SmithersError &&
    !label &&
    !options.code &&
    !options.details
  ) {
    return normalizedCause;
  }

  const code = options.code ?? (
    normalizedCause instanceof SmithersError
      ? normalizedCause.code
      : "INTERNAL_ERROR"
  );
  const details = {
    ...(normalizedCause instanceof SmithersError ? normalizedCause.details : {}),
    ...(options.details ?? {}),
  };
  if (label && details.operation === undefined) {
    details.operation = label;
  }

  const summary =
    label
      ? `${label}: ${
          normalizedCause instanceof SmithersError
            ? normalizedCause.summary
            : normalizedCause instanceof Error
              ? normalizedCause.message
              : String(normalizedCause)
        }`
      : normalizedCause instanceof SmithersError
        ? normalizedCause.summary
        : normalizedCause instanceof Error
          ? normalizedCause.message
          : String(normalizedCause);

  return new SmithersError(
    code,
    summary,
    Object.keys(details).length > 0 ? details : undefined,
    { cause: normalizedCause },
  );
}

export function isSmithersError(err: unknown): err is SmithersError {
  return Boolean(err && typeof err === "object" && (err as any).code);
}

export type SerializedError = Record<string, unknown> & {
  name?: string;
  message?: string;
  stack?: string;
  cause?: unknown;
  code?: unknown;
  details?: unknown;
  summary?: unknown;
  docsUrl?: unknown;
};

export function errorToJson(err: unknown): SerializedError {
  const taggedError = fromTaggedError(err);
  if (taggedError) {
    return errorToJson(taggedError);
  }

  if (err instanceof Error) {
    const anyErr = err as any;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: anyErr?.cause,
      code: anyErr?.code,
      details: anyErr?.details,
      summary: anyErr?.summary,
      docsUrl: anyErr?.docsUrl,
    };
  }
  if (err && typeof err === "object") {
    return err as SerializedError;
  }
  return { message: String(err) };
}
