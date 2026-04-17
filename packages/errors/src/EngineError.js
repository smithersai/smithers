import { Data } from "effect";

/** @typedef {import("./EngineErrorCode.ts").EngineErrorCode} EngineErrorCode */

/**
 * @typedef {{
 *   readonly code: EngineErrorCode;
 *   readonly message: string;
 *   readonly context?: Record<string, unknown>;
 * }} EngineErrorArgs
 */

const EngineErrorBase = /** @type {new (args: EngineErrorArgs) => import("effect/Cause").YieldableError & { readonly _tag: "EngineError" } & Readonly<EngineErrorArgs>} */ (
  Data.TaggedError("EngineError")
);

export class EngineError extends EngineErrorBase {}
