import type { TaggedErrorDetails } from "./TaggedErrorDetails.ts";

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
