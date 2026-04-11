import { Data } from "effect";
import type { EngineErrorCode } from "./EngineErrorCode.ts";

export class EngineError extends Data.TaggedError("EngineError")<{
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}> {}
