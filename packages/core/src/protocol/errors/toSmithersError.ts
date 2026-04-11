import { SmithersError } from "./SmithersError";
import { EngineError } from "./EngineError";
import { fromTaggedError } from "./fromTaggedError";
import { isSmithersError } from "./isSmithersError";
import type { ErrorWrapOptions } from "./ErrorWrapOptions";

function causeSummary(cause: unknown): string {
  if (isSmithersErrorLike(cause)) {
    return typeof cause.summary === "string" ? cause.summary : cause.message;
  }
  if (cause instanceof EngineError) {
    return cause.message;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function isSmithersErrorLike(cause: unknown): cause is SmithersError {
  return cause instanceof SmithersError || isSmithersError(cause);
}

export function toSmithersError(
  cause: unknown,
  label?: string,
  options: ErrorWrapOptions = {},
): SmithersError {
  const taggedError = fromTaggedError(cause);
  const normalizedCause = taggedError ?? cause;
  const smithersCause = isSmithersErrorLike(normalizedCause);
  if (
    smithersCause &&
    !label &&
    !options.code &&
    !options.details
  ) {
    return normalizedCause;
  }
  const code =
    options.code ??
    (smithersCause
      ? normalizedCause.code
      : normalizedCause instanceof EngineError
        ? normalizedCause.code
        : "INTERNAL_ERROR");
  const details = {
    ...(smithersCause ? normalizedCause.details : {}),
    ...(normalizedCause instanceof EngineError ? normalizedCause.context : {}),
    ...options.details,
  };
  if (label && details.operation === undefined) {
    details.operation = label;
  }
  const summary = label
    ? `${label}: ${causeSummary(normalizedCause)}`
    : causeSummary(normalizedCause);
  return new SmithersError(
    code,
    summary,
    Object.keys(details).length > 0 ? details : undefined,
    { cause: normalizedCause },
  );
}
