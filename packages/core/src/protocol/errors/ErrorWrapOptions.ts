import type { SmithersErrorCode } from "./SmithersErrorCode";

export type ErrorWrapOptions = {
  readonly code?: SmithersErrorCode;
  readonly details?: Record<string, unknown>;
};
