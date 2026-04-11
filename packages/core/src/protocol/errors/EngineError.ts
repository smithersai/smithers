import { Data } from "effect";
import type { EngineErrorCode } from "./EngineErrorCode";

export class EngineError extends Data.TaggedError("EngineError")<{
  readonly code: EngineErrorCode;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}> {}
