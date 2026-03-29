import type { SmithersErrorCode } from "./utils/errors";

export type SmithersError = {
  code: SmithersErrorCode;
  message: string;
  summary: string;
  docsUrl: string;
  details?: Record<string, unknown>;
  cause?: unknown;
};
