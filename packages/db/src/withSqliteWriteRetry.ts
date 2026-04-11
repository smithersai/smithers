import { Effect } from "effect";
import { runPromise } from "@smithers/runtime/runtime";
import { toSmithersError } from "@smithers/errors/toSmithersError";
import { withSqliteWriteRetryEffect } from "./withSqliteWriteRetryEffect";
import type { SqliteWriteRetryOptions } from "./SqliteWriteRetryOptions";

export async function withSqliteWriteRetry<T>(
  operation: () => Promise<T>,
  opts: SqliteWriteRetryOptions = {},
): Promise<T> {
  return runPromise(
    withSqliteWriteRetryEffect(
      () =>
        Effect.tryPromise({
          try: () => operation(),
          catch: (cause) =>
            toSmithersError(cause, opts.label ?? "sqlite write", {
              code: "DB_WRITE_FAILED",
            }),
        }),
      opts,
    ),
  );
}
