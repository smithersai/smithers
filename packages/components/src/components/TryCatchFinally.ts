import React from "react";
import type { SmithersErrorCode } from "@smithers/errors/SmithersErrorCode";
import type { SmithersError } from "@smithers/errors/SmithersError";
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
export declare function TryCatchFinally(props: TryCatchFinallyProps): React.ReactElement | null;
