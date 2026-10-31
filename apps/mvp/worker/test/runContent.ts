// Run transcripts for Node tests (docs/features/agent-transcripts.md#tests): the store `RunContent` keeps
// (worker/runners/RunContent.ts) on Node's own SQLite, one in-memory database per run, through the same synchronous
// port the Durable Object gives it over its storage. `transcripts` is the `Transcripts` service over those stores, as
// ChatApi's is over the `RunContent` namespace; only the host differs. e2e/agent-runner.spec.ts runs the
// object itself under `alchemy dev`.
import { Effect, Layer } from "effect"
import { DatabaseSync } from "node:sqlite"
import * as Store from "../runners/RunContent.ts"

/** A fresh store on an in-memory SQLite. */
export const sqliteStore = (): Store.Sql => {
  const db = new DatabaseSync(":memory:")
  const sql: Store.Sql = {
    exec: (query, ...bindings) =>
      db.prepare(query).all(...bindings) as unknown as ReadonlyArray<Record<string, Store.SqlValue>>,
  }
  Store.migrate(sql)
  return sql
}

/** `Transcripts` over one SQLite store per run, and the stores by run id, for a test to read. */
export const transcripts = () => {
  const runs = new Map<string, Store.Sql>()
  const of = (runId: string) => {
    const known = runs.get(runId)
    if (known !== undefined) return known
    const made = sqliteStore()
    runs.set(runId, made)
    return made
  }
  const layer = Layer.succeed(Store.Transcripts, Store.Transcripts.of({
    append: (runId, generation, events) =>
      Effect.sync(() => {
        const appended = Store.append(of(runId), generation, events, Date.now())
        return { next: appended.next, summary: appended.summary }
      }),
  }))
  return { layer, runs, of }
}
