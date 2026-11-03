import { ShapeSource } from "@smthrs/effect-electric"
import { Effect, Option } from "effect"
import { SqlClient } from "effect/sql"

/** One fixture request: a refusal fails at its caller, without hiding it behind a retry. */
export const shapeRequest = (url: string, stage: "open" | "delete") =>
  Effect.gen(function* () {
    const source = yield* ShapeSource.ShapeSource
    const response = yield* source.request(url, {})
    if (response.status === 503) {
      const requestId = response.headers.get("x-request-id")
      yield* Effect.logWarning("test.electric.unavailable").pipe(Effect.annotateLogs({
        stage, status: response.status,
        ...(requestId !== null && /^[a-zA-Z0-9_-]{1,96}$/.test(requestId) ? { requestId } : {}),
      }))
      const client = yield* Effect.serviceOption(SqlClient.SqlClient)
      if (Option.isSome(client)) {
        // Keep the lock graph when a fixture refuses: no SQL text, bind values, response body or URL.
        yield* client.value`SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers,
          extract(epoch FROM clock_timestamp() - xact_start)::int AS transaction_seconds,
          substring(upper(ltrim(query)) FROM '^(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)( |$)') AS command
          FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`.pipe(
          Effect.flatMap(waits => Effect.logWarning("test.electric.database_waits").pipe(Effect.annotateLogs({ stage, waits }))),
          Effect.catch(() => Effect.logWarning("test.electric.diagnostics_unavailable")),
        )
      }
    }
    return response
  })
