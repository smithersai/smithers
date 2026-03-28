export type SmithersErrorCode =
  // Engine: Run lifecycle
  | "INVALID_INPUT"
  | "MISSING_INPUT"
  | "MISSING_INPUT_TABLE"
  | "RESUME_METADATA_MISMATCH"
  | "UNKNOWN_OUTPUT_SCHEMA"
  | "INVALID_OUTPUT"
  | "WORKTREE_CREATE_FAILED"
  | "VCS_NOT_FOUND"

  // DOM / Component tree
  | "TASK_ID_REQUIRED"
  | "TASK_MISSING_OUTPUT"
  | "DUPLICATE_ID"
  | "NESTED_LOOP"
  | "WORKTREE_EMPTY_PATH"
  | "MDX_PRELOAD_INACTIVE"
  | "CONTEXT_OUTSIDE_WORKFLOW"
  | "MISSING_OUTPUT"

  // Tools
  | "TOOL_PATH_INVALID"
  | "TOOL_PATH_ESCAPE"
  | "TOOL_FILE_TOO_LARGE"
  | "TOOL_CONTENT_TOO_LARGE"
  | "TOOL_PATCH_TOO_LARGE"
  | "TOOL_PATCH_FAILED"
  | "TOOL_NETWORK_DISABLED"
  | "TOOL_GIT_REMOTE_DISABLED"
  | "TOOL_COMMAND_FAILED"
  | "TOOL_GREP_FAILED"

  // Agents
  | "AGENT_CLI_ERROR"
  | "AGENT_RPC_FILE_ARGS"
  | "AGENT_BUILD_COMMAND"

  // TOON / Effect Builder
  | "TOON_INVALID_FILE"
  | "TOON_SCHEMA_INVALID"
  | "TOON_DUPLICATE_SCHEMA"
  | "TOON_DUPLICATE_COMPONENT"
  | "TOON_COMPONENT_MISSING_STEPS"
  | "TOON_DUPLICATE_STEP"
  | "TOON_UNKNOWN_DEPENDENCY"
  | "TOON_AGENT_CONFIG_INVALID"
  | "TOON_NOT_FOUND"
  | "TOON_PLUGIN_INVALID"
  | "TOON_UNKNOWN_NODE"
  | "TOON_STEP_MISSING_OUTPUT"
  | "TOON_STEP_AMBIGUOUS"
  | "TOON_STEP_MISSING_AGENT"
  | "TOON_HANDLER_INVALID"
  | "TOON_WORKFLOW_INVALID"
  | "TOON_NESTED_LOOP"
  | "TOON_DUPLICATE_ALIAS"

  // Database
  | "DB_MISSING_COLUMNS"
  | "DB_REQUIRES_BUN_SQLITE"

  // BAML Plugin
  | "BAML_COMMAND_FAILED"
  | "BAML_MANIFEST_NOT_FOUND"
  | "BAML_MANIFEST_INVALID"
  | "BAML_ENTRY_NOT_FOUND"
  | "BAML_REQUIRES_BUN"

  // Misc
  | "SCHEMA_CHANGE_HOT"
  | "APPROVAL_OUTSIDE_TASK"
  | "TASK_RUNTIME_UNAVAILABLE"
  | "WORKFLOW_MISSING_DEFAULT"

  // Escape hatch for custom user codes
  | (string & {});

export class SmithersError extends Error {
  code: SmithersErrorCode;
  details?: Record<string, unknown>;

  constructor(
    code: SmithersErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
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
};

export function errorToJson(err: unknown): SerializedError {
  if (err instanceof Error) {
    const anyErr = err as any;
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: anyErr?.cause,
      code: anyErr?.code,
      details: anyErr?.details,
    };
  }
  if (err && typeof err === "object") {
    return err as SerializedError;
  }
  return { message: String(err) };
}
