import { Effect } from "effect";
import {
  type SmithersErrorCode,
  SmithersError,
  toSmithersError,
} from "../utils/errors";

export type ErrorWrapOptions = {
  code?: SmithersErrorCode;
  details?: Record<string, unknown>;
};

export function toError(
  cause: unknown,
  label?: string,
  options: ErrorWrapOptions = {},
): SmithersError {
  return toSmithersError(cause, label, options);
}

export function fromPromise<A>(
  label: string,
  evaluate: () => PromiseLike<A>,
  options: ErrorWrapOptions = {},
): Effect.Effect<A, SmithersError> {
  return Effect.tryPromise({
    try: () => evaluate(),
    catch: (cause) => toError(cause, label, options),
  });
}

export function fromSync<A>(
  label: string,
  evaluate: () => A,
  options: ErrorWrapOptions = {},
): Effect.Effect<A, SmithersError> {
  return Effect.try({
    try: () => evaluate(),
    catch: (cause) => toError(cause, label, options),
  });
}

/**
 * Run a synchronous side-effect, silently swallowing any thrown error.
 * Useful for best-effort cleanup (process.kill, sqlite.close, etc.).
 */
export function ignoreSyncError(label: string, fn: () => void): Effect.Effect<void> {
  return Effect.sync(() => {
    try {
      fn();
    } catch {
      // intentionally swallowed – best-effort cleanup
    }
  });
}

