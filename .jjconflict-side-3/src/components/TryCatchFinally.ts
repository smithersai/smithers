import React from "react";
import type { SmithersErrorCode, SmithersError } from "../utils/errors";

export type TryCatchFinallyProps = {
  id?: string;
  try: React.ReactElement;
  catch?: React.ReactElement | ((error: SmithersError) => React.ReactElement);
  catchErrors?: SmithersErrorCode[];
  finally?: React.ReactElement;
  skipIf?: boolean;
};

/**
 * Workflow-scoped error boundary. Catch specific error types, run recovery
 * handlers, and ensure cleanup always runs.
 *
 * - The `try` block is the main workflow content.
 * - If any task in `try` fails with a matching error, the `catch` block mounts.
 * - The `finally` block always runs after try (success) or catch (failure).
 *
 * Renders to `<smithers:try-catch-finally>`.
 */
export function TryCatchFinally(
  props: TryCatchFinallyProps,
): React.ReactElement | null {
  if (props.skipIf) return null;

  const {
    id,
    catch: catchHandler,
    catchErrors,
    finally: finallyHandler,
    ...rest
  } = props;
  const tryBlock = props.try;

  const hostProps: Record<string, any> = {
    ...rest,
    id,
    __tcfCatchErrors: catchErrors,
    __tcfCatchHandler: catchHandler,
    __tcfFinallyHandler: finallyHandler,
  };

  // The try block is always the child of the host element.
  // catch and finally are stored as metadata for the engine.
  return React.createElement("smithers:try-catch-finally", hostProps, tryBlock);
}
