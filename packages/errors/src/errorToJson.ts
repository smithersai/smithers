import { SmithersError } from "./SmithersError.ts";
import { fromTaggedError } from "./fromTaggedError.ts";

export function errorToJson(error: unknown): Record<string, unknown> {
  const taggedError = fromTaggedError(error);
  if (taggedError) {
    return errorToJson(taggedError);
  }
  if (error instanceof SmithersError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
      summary: error.summary,
      docsUrl: error.docsUrl,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (error && typeof error === "object") {
    return error as Record<string, unknown>;
  }
  return { message: String(error) };
}
