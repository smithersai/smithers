import { Data } from "effect";

/** @typedef {import("./TaggedErrorDetails.ts").TaggedErrorDetails} TaggedErrorDetails */

/**
 * @typedef {{
 *   readonly message: string;
 *   readonly details?: TaggedErrorDetails;
 *   readonly name?: string;
 * }} TaskAbortedArgs
 */

const TaskAbortedBase = /** @type {new (args: TaskAbortedArgs) => import("effect/Cause").YieldableError & { readonly _tag: "TaskAborted" } & Readonly<TaskAbortedArgs>} */ (
  Data.TaggedError("TaskAborted")
);

export class TaskAborted extends TaskAbortedBase {}
