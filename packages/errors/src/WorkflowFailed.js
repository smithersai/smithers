import { Data } from "effect";

/** @typedef {import("./TaggedErrorDetails.ts").GenericTaggedErrorArgs} GenericTaggedErrorArgs */

/**
 * @typedef {GenericTaggedErrorArgs & {
 *   readonly status?: number;
 * }} WorkflowFailedArgs
 */

const WorkflowFailedBase = /** @type {new (args: WorkflowFailedArgs) => import("effect/Cause").YieldableError & { readonly _tag: "WorkflowFailed" } & Readonly<WorkflowFailedArgs>} */ (
  Data.TaggedError("WorkflowFailed")
);

export class WorkflowFailed extends WorkflowFailedBase {}
