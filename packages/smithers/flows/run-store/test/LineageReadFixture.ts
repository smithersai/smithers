import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import type * as Statement from "effect/sql/Statement"
import type * as RunStore from "../src/RunStore.ts"

/** Measures payload text returned by the real SQL client, without replacing any query or result. */
export const observedSql = (observe: (bytes: number) => void) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* SqlClient.SqlClient
      return new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<
            Record<string, unknown>
          >
          if (!/^\s*SELECT\b/i.test(statement.compile()[0])) return statement
          return Effect.tap(statement, (rows) =>
            Effect.sync(() => {
              let bytes = 0
              for (const row of rows) {
                for (const key of ["stateJson", "state_json", "payload_json"]) {
                  const value = row[key]
                  if (typeof value === "string") bytes += new TextEncoder().encode(value).byteLength
                }
              }
              observe(bytes)
            }))
        }
      }) as SqlClient.SqlClient
    })
  )

/** Distinct, wide trees defeat admission-cache reuse across historical rounds. */
export const stateText = (ordinal: number) =>
  JSON.stringify({
    ordinal,
    changes: Array.from({ length: 240 }, (_, id) => ({
      id,
      title: "word ".repeat(12),
      revision: String(ordinal * 240 + id).padStart(40, "c"),
      status: "completed"
    }))
  })

/** Seeds real run and journal tables; only the final round remains open. */
export const history = (store: RunStore.Service, count: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    for (let ordinal = 0; ordinal <= count; ordinal++) {
      const id = `round-${ordinal}`
      const text = stateText(ordinal)
      yield* store.create(id, text, {
        lineageId: "round-0",
        roundOrdinal: ordinal,
        ...(ordinal === 0 ? {} : { parentRunId: `round-${ordinal - 1}` })
      })
      yield* sql`INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
        VALUES (${id}, 0, ${id}, 'fixture', 0, 0, 'fixture.state', ${text}, '{}')`
    }
    yield* sql`UPDATE flows_runs SET status = 'completed',
      started_at_ms = created_at_ms, finished_at_ms = created_at_ms WHERE round_ordinal < ${count}`
  })
