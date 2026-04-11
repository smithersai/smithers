import { SmithersError } from "./SmithersError";
import { EngineError } from "./EngineError";
import { fromTaggedError } from "./fromTaggedError";
import type { ErrorWrapOptions } from "./ErrorWrapOptions";

function causeSummary(cause: unknown): string {
  if (cause instanceof SmithersError) {
    return cause.summary;
  }
  if (cause instanceof EngineError) {
    return cause.message;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

export function toSmithersError(
  cause: unknown,
  label?: string,
  options: ErrorWrapOptions = {},
): SmithersError {
  const taggedError = fromTaggedError(cause);
  const normalizedCause = taggedError ?? cause;
  if (
    normalizedCause instanceof SmithersError &&
    !label &&
    !options.code &&
    !options.details
  ) {
    return normalizedCause;
  }
  const code =
    options.code ??
    (normalizedCause instanceof SmithersError
      ? normalizedCause.code
      : normalizedCause instanceof EngineError
        ? normalizedCause.code
        : "INTERNAL_ERROR");
  const details = {
    ...(normalizedCause instanceof SmithersError ? normalizedCause.details : {}),
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
