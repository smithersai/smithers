import {
  type ErrorWrapOptions,
  type SmithersError,
  toSmithersError,
} from "../errors.ts";

export function toError(
  cause: unknown,
  label?: string,
  options: ErrorWrapOptions = {},
): SmithersError {
  return toSmithersError(cause, label, options);
}
