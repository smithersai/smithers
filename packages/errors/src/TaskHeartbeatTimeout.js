import { Data } from "effect";

/**
 * @typedef {{
 *   readonly message: string;
 *   readonly nodeId: string;
 *   readonly iteration: number;
 *   readonly attempt: number;
 *   readonly timeoutMs: number;
 *   readonly staleForMs: number;
 *   readonly lastHeartbeatAtMs: number;
 * }} TaskHeartbeatTimeoutArgs
 */

const TaskHeartbeatTimeoutBase = /** @type {new (args: TaskHeartbeatTimeoutArgs) => import("effect/Cause").YieldableError & { readonly _tag: "TaskHeartbeatTimeout" } & Readonly<TaskHeartbeatTimeoutArgs>} */ (
  Data.TaggedError("TaskHeartbeatTimeout")
);

export class TaskHeartbeatTimeout extends TaskHeartbeatTimeoutBase {}
