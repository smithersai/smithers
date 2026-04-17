import { Data } from "effect";

/** @typedef {import("./TaggedErrorDetails.ts").GenericTaggedErrorArgs} GenericTaggedErrorArgs */

const InvalidInputBase = /** @type {new (args: GenericTaggedErrorArgs) => import("effect/Cause").YieldableError & { readonly _tag: "InvalidInput" } & Readonly<GenericTaggedErrorArgs>} */ (
  Data.TaggedError("InvalidInput")
);

export class InvalidInput extends InvalidInputBase {}
