import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { afterAll, describe, test } from "vitest"
import { Journal, JournalEvent, Projection, Redaction } from "../src/index.ts"
import * as TestJournal from "../src/test/TestJournal.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const journal = Context.get(
  await Effect.runPromise(Layer.buildWithScope(TestJournal.layer({ capacity: 4096 }), scope)),
  Journal.Journal
)

const runId = Schema.decodeUnknownSync(JournalEvent.RunId)("bench-run-1")
const readRunId = Schema.decodeUnknownSync(JournalEvent.RunId)("bench-run-read")
const sourceId = Schema.decodeUnknownSync(JournalEvent.SourceId)("bench-source")

// Seed 200 committed entries for read / projection benchmarks.
for (let i = 0; i < 200; i++) {
  await Effect.runPromise(
    journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: readRunId,
        sourceId,
        eventType: "step.completed",
        payload: { stepId: `step-${i}`, status: "ok", durationMs: 12 + (i % 40) }
      })
    )
  )
}

const cleanPayload = {
  runId: "bench-run-1",
  stepId: "build-worker",
  status: "succeeded",
  files: ["packages/smithers/flows/src/index.ts", "packages/smithers/flows/engine/src/Engine.ts"],
  metrics: { durationMs: 142, cacheHit: true, bytes: 8192 }
}

const secretPayload = {
  stepId: "deploy",
  headers: {
    authorization: "Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",
    "x-api-key": "ghp_0123456789abcdefghijklmnopqrstuvwxyz"
  },
  env: {
    GITHUB_TOKEN: "ghp_secretvalue1234567890abcdef",
    NODE_ENV: "production"
  },
  message: "Connected to postgres://smithers:supersecret@db.internal:5432/prod"
}

const logLines = Array.from({ length: 32 }, (_, i) =>
  i % 8 === 0
    ? `[INFO] request auth=Bearer sk-proj-0123456789abcdef0123456789abcdef status=200`
    : `[INFO] step-${i} completed in ${10 + i}ms (cached=false, bytes=4096)`)

const countProjection = Projection.make({
  name: "count",
  initial: 0,
  reduce: (count) => Effect.succeed(count + 1)
})

let durableCounter = 0
const emitDurableOne = Effect.suspend(() =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId,
      sourceId,
      eventType: "step.completed",
      payload: { stepId: `s-${durableCounter++}`, ok: true }
    })
  )
)

const emitLossyBatch = Effect.gen(function*() {
  for (let i = 0; i < 16; i++) {
    yield* journal.emitLossy(
      new JournalEvent.Input({
        runId,
        sourceId,
        eventType: "telemetry.tick",
        payload: { tick: i, ok: true }
      })
    )
  }
  yield* journal.flush
})

const readPage200 = journal.entries({ runId: readRunId, limit: 200 })
const project200 = journal.project(countProjection, { runId: readRunId }).pipe(
  Stream.take(200),
  Stream.runLast
)

const runPromise = Effect.runPromise
const redactFn = Redaction.redact
const makeLineRedactor = Redaction.lineRedactor
const opts = { time: 120, warmupTime: 30 }
const slowOpts = { iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 }

describe("@smthrs/journal", () => {
  test("Redaction.redact clean and secret-bearing payloads", async ({ bench }) => {
    await bench("Redaction.redact (clean)", () => {
      redactFn(cleanPayload)
    }).run(opts)

    await bench("Redaction.redact (secrets)", () => {
      redactFn(secretPayload)
    }).run(opts)
  })

  test("Redaction.lineRedactor 32 log lines", async ({ bench }) => {
    await bench("lineRedactor (32 lines)", () => {
      const lr = makeLineRedactor()
      for (const l of logLines) lr.line(l)
      lr.flush()
    }).run(opts)
  })

  test("SqlJournal emitDurableUnfenced single event", async ({ bench }) => {
    await bench("emitDurableUnfenced", () => runPromise(emitDurableOne)).run(opts)
  })

  test("SqlJournal emitLossy x16 + flush", async ({ bench }) => {
    await bench("emitLossy x16 + flush", () => runPromise(emitLossyBatch)).run(slowOpts)
  })

  test("SqlJournal entries page read (200 entries)", async ({ bench }) => {
    await bench("entries (200 rows)", () => runPromise(readPage200)).run(slowOpts)
  })

  test("SqlJournal project replay (200 entries)", async ({ bench }) => {
    await bench("project replay (200 rows)", () => runPromise(project200)).run(slowOpts)
  })
})
