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
