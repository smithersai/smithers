import type { TaskAborted } from "./TaskAborted";
import type { TaskTimeout } from "./TaskTimeout";
import type { TaskHeartbeatTimeout } from "./TaskHeartbeatTimeout";
import type { RunNotFound } from "./RunNotFound";
import type { InvalidInput } from "./InvalidInput";
import type { DbWriteFailed } from "./DbWriteFailed";
import type { AgentCliError } from "./AgentCliError";
import type { WorkflowFailed } from "./WorkflowFailed";

export type SmithersTaggedError =
  | TaskAborted
  | TaskTimeout
  | TaskHeartbeatTimeout
  | RunNotFound
  | InvalidInput
  | DbWriteFailed
  | AgentCliError
  | WorkflowFailed;
