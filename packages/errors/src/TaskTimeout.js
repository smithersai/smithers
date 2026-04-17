import { Data } from "effect";

/**
 * @typedef {{
 *   readonly message: string;
 *   readonly nodeId: string;
 *   readonly attempt: number;
 *   readonly timeoutMs: number;
 * }} TaskTimeoutArgs
 */

const TaskTimeoutBase = /** @type {new (args: TaskTimeoutArgs) => import("effect/Cause").YieldableError & { readonly _tag: "TaskTimeout" } & Readonly<TaskTimeoutArgs>} */ (
  Data.TaggedError("TaskTimeout")
);

export class TaskTimeout extends TaskTimeoutBase {}
