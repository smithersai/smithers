import { Data } from "effect";

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
