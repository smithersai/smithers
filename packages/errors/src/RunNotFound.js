import { Data } from "effect";

/**
 * @typedef {{
 *   readonly message: string;
 *   readonly runId: string;
 * }} RunNotFoundArgs
 */

const RunNotFoundBase = /** @type {new (args: RunNotFoundArgs) => import("effect/Cause").YieldableError & { readonly _tag: "RunNotFound" } & Readonly<RunNotFoundArgs>} */ (
  Data.TaggedError("RunNotFound")
);

export class RunNotFound extends RunNotFoundBase {}
