import {
  type ErrorWrapOptions,
  type SmithersError,
  toSmithersError,
} from "@smithers/errors";

export function toError(
  cause: unknown,
  label?: string,
  options: ErrorWrapOptions = {},
): SmithersError {
  return toSmithersError(cause, label, options);
}
