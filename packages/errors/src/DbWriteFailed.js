import { Data } from "effect";

/** @typedef {import("./TaggedErrorDetails.ts").GenericTaggedErrorArgs} GenericTaggedErrorArgs */

const DbWriteFailedBase = /** @type {new (args: GenericTaggedErrorArgs) => import("effect/Cause").YieldableError & { readonly _tag: "DbWriteFailed" } & Readonly<GenericTaggedErrorArgs>} */ (
  Data.TaggedError("DbWriteFailed")
);

export class DbWriteFailed extends DbWriteFailedBase {}
