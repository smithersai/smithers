import type { SmithersErrorCode } from "./SmithersErrorCode.ts";

export type ErrorWrapOptions = {
  readonly code?: SmithersErrorCode;
  readonly details?: Record<string, unknown>;
};
