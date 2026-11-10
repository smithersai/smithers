/**
 * `CloudflareRuntime`'s `retention` in a Durable Object's own SQLite (a `node:sqlite` copy that refuses transaction
 * SQL as the real storage does, `fixtures/SqliteStorage.ts`). A host that runs one execution per invocation, as a
 * per-person object does, grows its engine store by one run each time; nothing else deletes from it, because
 * `smithers gc` runs on a host's files. The pass runs when the runtime is built, over the engine's own terminal-run
 * state: `Retention.collect`'s terminal, aged and lineage-guarded candidates, with the driven execution pinned.
 */
import { describe, expect, it } from "@effect/vitest"
import { FlowRuntime } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { CloudflareRuntime, ExecutionObject, ObjectDatabase } from "../src/index.ts"
import { Answer, registration } from "./fixtures/AnswerFlow.ts"
import * as MemoryStorage from "./fixtures/MemoryStorage.ts"
import * as Objects from "./fixtures/Objects.ts"
import * as SqliteStorage from "./fixtures/SqliteStorage.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const hostId = "person-object"

/** One invocation of the object: a runtime for `executionId` over its storage, which executes `pauseMs` of Answer. */
const invoke = (
  store: SqliteStorage.SqliteStorage,
  executionId: string,
  steps: Array<string>,
  options: { readonly retention?: CloudflareRuntime.Retention; readonly pauseMs?: number } = {}
) =>
  Effect.scoped(
    Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) =>
      runtime.execute(Answer, { executionId, payload: { question: executionId, pauseMs: options.pauseMs ?? 0 } })).pipe(
        Effect.provide(
          CloudflareRuntime.layer(
            {
              hostId,
              executionId,
              flow: Answer._tag,
              ...(options.retention === undefined ? {} : { retention: options.retention })
            },
            registration((label) =>
              Effect.sync(() =>
                steps.push(label)
              ).pipe(Effect.as(label))
            )
          ).pipe(Layer.provide(ObjectDatabase.layer(store.storage)))
        )
      )
  )

const rows = (store: SqliteStorage.SqliteStorage) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const runs = yield* sql<
      { readonly run_id: string; readonly status: string }
    >`SELECT run_id, status FROM flows_runs ORDER BY run_id`
    const events = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM flows_journal_events`
    const attempts = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM flows_attempts`
    return { runs, events: events[0]!.count, attempts: attempts[0]!.count }
  }).pipe(Effect.provide(ObjectDatabase.layer(store.storage)))

describe("CloudflareRuntime retention in a Durable Object's SQLite", () => {
  it.effect("keeps one invocation per execution from growing the store without bound", () => {
    const store = SqliteStorage.make()
    const steps: Array<string> = []
    return Effect.gen(function*() {
      for (let n = 0; n < 30; n++) {
        yield* invoke(store, `meter/${String(n).padStart(2, "0")}`, steps, { retention: { olderThanMs: 0 } })
        yield* TestClock.adjust("1 millis")
      }
      const after = yield* rows(store)
      // Each invocation deletes every run that finished before it; the latest one remains.
      expect(after.runs).toEqual([{ run_id: "meter/29", status: "completed" }])
      expect(steps).toHaveLength(60)
      // The deleted runs' journal and attempts went with them.
      const single = SqliteStorage.make()
      yield* invoke(single, "meter/29", [], {})
      expect(after.events).toBe((yield* rows(single)).events)
      expect(after.attempts).toBe((yield* rows(single)).attempts)
    })
  })

  it.effect("without retention every run stays, as before", () => {
    const store = SqliteStorage.make()
    return Effect.gen(function*() {
      for (let n = 0; n < 5; n++) {
        yield* invoke(store, `meter/${n}`, [])
        yield* TestClock.adjust("1 millis")
      }
      expect((yield* rows(store)).runs).toHaveLength(5)
    })
  })

  it.effect("keeps a parked run, a young run and the execution it drives", () => {
    const store = SqliteStorage.make()
    const steps: Array<string> = []
    const retention = { olderThanMs: 60_000 }
    return Effect.gen(function*() {
      // A run parked on its hour-long timer is live at any age: the object's alarm drives it until it parks.
      const kv = MemoryStorage.make()
      const intent = yield* ExecutionObject.intent(Answer, {
        executionId: "parked",
        payload: { question: "parked", pauseMs: 3_600_000 }
      })
      yield* ExecutionObject.start(kv.storage, intent, Effect.void)
      const outcome = yield* ExecutionObject.alarm(kv.storage, {
        flows: [Answer],
        runtime: (driven) =>
          CloudflareRuntime.layer(
            { hostId, executionId: driven.executionId, flow: Answer._tag, retention },
            registration((label) => Effect.sync(() => steps.push(label)).pipe(Effect.as(label)))
          ).pipe(Layer.provide(ObjectDatabase.layer(store.storage))),
        router: Objects.unrouted
      })
      expect(outcome._tag).toBe("Parked")
      yield* TestClock.adjust("1 second")
      yield* invoke(store, "old", steps, { retention })
      yield* TestClock.adjust("2 minutes")
      yield* invoke(store, "young", steps, { retention })
      // "old" finished two minutes ago, so this invocation deletes it; "young" finished just now.
      yield* invoke(store, "driver", steps, { retention })
      expect((yield* rows(store)).runs.map((run) => run.run_id)).toEqual(["driver", "parked", "young"])
      // A runtime for an aged, settled execution never deletes it: the pin keeps its recorded result readable.
      yield* TestClock.adjust("10 minutes")
      const polled = yield* Effect.scoped(
        Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) => runtime.poll(Answer, "young")).pipe(
          Effect.provide(
            CloudflareRuntime.layer(
              { hostId, executionId: "young", flow: Answer._tag, retention },
              registration(Effect.succeed)
            ).pipe(
              Layer.provide(ObjectDatabase.layer(store.storage))
            )
          )
        )
      )
      expect(polled).toMatchObject({ _tag: "Some", value: { _tag: "Complete" } })
      // That pass deleted "driver", ten minutes settled, and kept the pinned "young".
      expect((yield* rows(store)).runs.map((run) => run.run_id)).toEqual(["parked", "young"])
      expect((yield* rows(store)).runs.find((run) => run.run_id === "parked")?.status).not.toBe("completed")
    })
  })

  it.effect("a pass that fails deletes nothing, and the execution still runs; telemetry carries counts only", () => {
    const store = SqliteStorage.make()
    const telemetry = Telemetry.make()
    const steps: Array<string> = []
    return Effect.gen(function*() {
      yield* invoke(store, "first", steps)
      yield* TestClock.adjust("1 millis")
      yield* invoke(store, "second", steps, { retention: { olderThanMs: 0 } })
      expect((yield* rows(store)).runs.map((run) => run.run_id)).toEqual(["second"])
      // A real fault in the real database: every delete of a run row aborts.
      yield* Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe(
          "CREATE TRIGGER refuse_run_delete BEFORE DELETE ON flows_runs BEGIN SELECT RAISE(ABORT, 'refused'); END"
        )
      }).pipe(Effect.provide(ObjectDatabase.layer(store.storage)))
      yield* TestClock.adjust("1 millis")
      expect(yield* invoke(store, "third", steps, { retention: { olderThanMs: 0 } })).toBe("answer")
      const after = yield* rows(store)
      expect(after.runs.map((run) => run.run_id)).toEqual(["second", "third"])
      expect(telemetry.lines(CloudflareRuntime.retentionLog).map((line) => line.annotations)).toEqual([
        expect.objectContaining({ outcome: "deleted", runs: 1 }),
        expect.objectContaining({ outcome: "failed", runs: 0, "error.type": "@smthrs/engine-store/RetentionError" })
      ])
      expect(telemetry.count(CloudflareRuntime.retentionPasses, { outcome: "deleted" })).toBe(1)
      expect(telemetry.count(CloudflareRuntime.retentionPasses, { outcome: "failed" })).toBe(1)
      expect(telemetry.count(CloudflareRuntime.retainedRunsDeleted, {})).toBe(1)
      expect(telemetry.named("smithers.cloudflare.retention")).toHaveLength(2)
      // Counts and outcomes only: no run id reaches retention's own lines.
      expect(JSON.stringify(telemetry.lines(CloudflareRuntime.retentionLog))).not.toMatch(/first|second|third/)
    }).pipe(telemetry.observed)
  })
})
