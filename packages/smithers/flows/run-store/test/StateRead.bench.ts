/**
 * Reads per second of a run whose state has not changed, by state size.
 *
 * A driver reads a run's row on every poll, claim and lifecycle check, and the
 * row's state changes only when a step or a round ends. Each case stores one
 * run in an in-memory SQLite database and measures `RunStore.get` on it. The
 * state has the shape that showed the cost: a merge queue's round payload, one
 * record per change, 240 changes for about 70 KB.
 *
 * `RunStore` admits a state text once and recognises it afterwards, so a read
 * costs the query plus one string comparison. Before that, every read parsed
 * the text twice and walked the tree once. To measure that baseline, run this
 * file on the parent of the commit that added it; it uses only the public
 * `RunStore` service.
 *
 * Run: `pnpm --filter @smthrs/run-store bench`. The line printed after each
 * case states its reads per second and the state's size.
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { afterAll, describe, test } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const store = Context.get(
  await Effect.runPromise(Layer.buildWithScope(
    RunStore.layer.pipe(Layer.provideMerge(Migrations.layer), Layer.provideMerge(TestDatabase.sqliteLayer)),
    scope
  )),
  RunStore.RunStore
)

/** A merge queue's round payload holding `changes` changes, as JSON text. */
const queueState = (changes: number): string =>
  JSON.stringify({
    config: { required: [1], maxAttempts: 2, maxBatch: 8, maxRuns: 4, window: 20, defaultDuration: 200 },
    state: {
      main: Array.from({ length: changes }, (_, id) => id),
      changes: Array.from({ length: changes }, (_, id) => ({
        id,
        seq: id,
        priority: 0,
        status: { _tag: "merged" },
        attempts: 0,
        revision: `${id}`.padStart(40, "c"),
        author: `lane-${id % 17}`,
        title: `change ${id}: ${"word ".repeat(12)}`
      })),
      runs: [],
      nextRun: changes,
      nextSeq: changes,
      landed: Array.from({ length: changes }, (_, id) => ({ change: id, run: id, at: 1_700_000_000_000 + id })),
      history: Array.from({ length: 20 }, (_, id) => ({ check: 1, duration: 200 + id })),
      pushing: null
    },
    cursor: changes,
    closed: false,
    round: changes
  })

describe("RunStore.get on a run whose state has not changed", () => {
  for (const changes of [1, 24, 240, 1_000]) {
    test(`${changes} changes`, async ({ bench }) => {
      const text = queueState(changes)
      const runId = `bench-${changes}`
      await Effect.runPromise(store.create(runId, text))
      const read = store.get(runId)
      const result = await bench(`${changes} changes`, () => Effect.runPromise(read)).run()
      const kilobytes = (new TextEncoder().encode(text).byteLength / 1024).toFixed(1)
      console.log(
        `${changes} changes, ${kilobytes} KB of state: ${Math.round(result.throughput.mean)} reads/s, ` +
          `${(1000 / result.throughput.mean).toFixed(3)} ms a read`
      )
    })
  }
})
