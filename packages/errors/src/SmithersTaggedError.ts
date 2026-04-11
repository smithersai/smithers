import type { TaskAborted } from "./TaskAborted.ts";
import type { TaskTimeout } from "./TaskTimeout.ts";
import type { TaskHeartbeatTimeout } from "./TaskHeartbeatTimeout.ts";
import type { RunNotFound } from "./RunNotFound.ts";
import type { InvalidInput } from "./InvalidInput.ts";
import type { DbWriteFailed } from "./DbWriteFailed.ts";
import type { AgentCliError } from "./AgentCliError.ts";
import type { WorkflowFailed } from "./WorkflowFailed.ts";

export type SmithersTaggedError =
  | TaskAborted
  | TaskTimeout
  | TaskHeartbeatTimeout
  | RunNotFound
  | InvalidInput
  | DbWriteFailed
  | AgentCliError
  | WorkflowFailed;
