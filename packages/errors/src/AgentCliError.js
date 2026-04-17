import { Data } from "effect";

/** @typedef {import("./TaggedErrorDetails.ts").GenericTaggedErrorArgs} GenericTaggedErrorArgs */

const AgentCliErrorBase = /** @type {new (args: GenericTaggedErrorArgs) => import("effect/Cause").YieldableError & { readonly _tag: "AgentCliError" } & Readonly<GenericTaggedErrorArgs>} */ (
  Data.TaggedError("AgentCliError")
);

export class AgentCliError extends AgentCliErrorBase {}
