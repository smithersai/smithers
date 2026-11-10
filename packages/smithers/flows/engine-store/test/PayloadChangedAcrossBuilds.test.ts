/**
 * A run parked under one build resumes under a build that changed its flow's
 * payload schema.
 *
 * The run's payload is recorded once, encoded with the first build's codec,
 * and every resume decodes it with the codec of the build that resumes. A
 * payload that no longer decodes, after a new required field or a changed
 * type, can never resume: the run settles `failed` with the interpreter's
 * typed `payload_changed` refusal, instead of dying in the decoder on every
 * wake and staying unsettled forever. A payload that still decodes, after a
 * new optional field, reaches the plan check, and the flow's payload schema
 * is part of its plan, so that run is refused `plan_changed`.
 *
 * Every case parks a run on a durable deferred, reopens the store with a new
 * engine, and resumes it. The storage matrix runs the file once on SQLite and
 * once on PostgreSQL.
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, JournalDecode } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Logger, Option, References, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as EventTypes from "../src/EventTypes.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { runPromise } from "./Sha256.ts"

const gate = DurableDeferred.make("payload-changed-gate", { success: Schema.Number })

const Ask = Action.make("payload-changed/ask", {
  payload: {},
  success: Schema.Number,
  tier: "irreversible",
  idempotencyKey: "payload-changed-ask"
})

const tag = "payload-changed/answer"

/** The first build: the payload names a topic. */
const First = Flow.make(tag, { payload: { topic: Schema.String }, success: Schema.Number, body: () => Ask.call({}) })

/** A later build that added an optional field: the recorded payload still decodes, and the plan differs. */
const Optional = Flow.make(tag, {
  payload: { topic: Schema.String, locale: Schema.optional(Schema.String) },
  success: Schema.Number,
  body: () => Ask.call({})
})

/** A later build that added a required field: the recorded payload no longer decodes. */
const Required = Flow.make(tag, {
  payload: { topic: Schema.String, locale: Schema.String },
  success: Schema.Number,
  body: () => Ask.call({})
})

/** A later build that changed the topic's type: the recorded string is no longer a number. */
const RemovedLiteral = Flow.make(tag, {
  payload: { topic: Schema.Literal("old-step") },
  success: Schema.Number,
  body: () => Ask.call({})
})

const Retyped = Flow.make(tag, { payload: { topic: Schema.Number }, success: Schema.Number, body: () => Ask.call({}) })

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "test", changeId: "test" }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const executionId = "payload-changed-run"

/** The run's lifecycle decisions, oldest first. */
const decisions = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const page = yield* journal.entries({
    runId: JournalEvent.RunId.make(executionId),
    eventTypes: [EventTypes.EventTypes.runDecision],
    limit: 1000
  })
  return page.entries.map((entry) => entry.payload as { readonly decision: string; readonly [key: string]: unknown })
})

interface Scenario {
  /** The resuming build's flow, typed as the first build's: the same tag under another payload schema. */
  readonly resumed: typeof First
  /** The code the resume is refused with. */
  readonly refusal: "plan_changed" | "payload_changed"
}

const scenarios: Record<string, Scenario> = {
  "optional-field": { resumed: Optional as unknown as typeof First, refusal: "plan_changed" },
  "required-field": { resumed: Required as unknown as typeof First, refusal: "payload_changed" },
  "rollback-removed-step": { resumed: RemovedLiteral as unknown as typeof First, refusal: "payload_changed" },
  retyped: { resumed: Retyped as unknown as typeof First, refusal: "payload_changed" }
}

it.each(Object.keys(scenarios))(
  "resumes a parked run whose payload schema changed: %s",
  async (name) => {
    const scenario = scenarios[name]!
    const root = await mkdtemp(join(tmpdir(), "smithers-payload-changed-"))
    const filename = PersistentDatabase.filename(join(root, "state.sqlite"))
    let asked = 0
    const diagnostics: Array<Readonly<Record<string, unknown>>> = []
    const capture = Logger.make((options) => {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
      if (annotations["boundary"] === "payload") diagnostics.push(annotations)
    })

    const drive = (first: boolean) =>
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({
          owner: { hostId: "payload-changed" },
          journalSource: "payload-changed",
          isAlive: () => Effect.succeed(false)
        })
        const flow = first ? First : scenario.resumed
        const layer = Layer.mergeAll(
          Ask.toLayer(() =>
            Effect.sync(() => {
              asked++
            }).pipe(Effect.andThen(DurableDeferred.await(gate)))
          ),
          Interpreter.layer(flow)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        return yield* Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          if (first) {
            yield* First.execute({ topic: "weather" }, { executionId, discard: true })
            yield* TestDatabase.until(Effect.map(store.get(executionId), (row) => row.status === "suspended"))
            return { status: (yield* store.get(executionId)).status, decisions: [], result: undefined }
          }
          yield* engine.deferredDone(gate, {
            flowName: flow._tag,
            executionId,
            deferredName: gate.name,
            exit: Exit.succeed(4)
          })
          yield* TestDatabase.until(
            Effect.map(store.get(executionId), (row) => row.status !== "suspended" && row.status !== "running")
          )
          return {
            status: (yield* store.get(executionId)).status,
            decisions: yield* decisions,
            result: yield* engine.poll(flow, executionId)
          }
        }).pipe(Effect.provide(layer))
      })).pipe(
        Effect.provide(jj),
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(JournalDecode.Identity, { objectId: "rollback-object", codeVersion: "rollback-build" }),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(filename)),
        Effect.orDie
      )

    try {
      expect((await runPromise(drive(true))).status).toBe("suspended")
      expect(asked).toBe(1)

      const resumed = await runPromise(drive(false))
      expect(resumed.status).toBe("failed")
      if (scenario.refusal === "payload_changed") {
        expect(diagnostics).toEqual([
          expect.objectContaining({ stepTag: tag, objectId: "rollback-object", codeVersion: "rollback-build" })
        ])
        expect(JSON.stringify(diagnostics)).not.toContain("weather")
      }
      // Refused before the body ran again: the parked step was not re-dispatched.
      expect(asked).toBe(1)
      // What a caller polling the run sees: a settled failure that says why,
      // decoded from the stored row as the interpreter's own typed refusal.
      const polled = Option.getOrThrow(resumed.result!)
      if (polled._tag !== "Complete" || Exit.isSuccess(polled.exit)) throw new Error("the run did not fail")
      expect(Interpreter.refusalCode(polled.exit.cause)).toEqual(Option.some(scenario.refusal))
      expect(Cause.squash(polled.exit.cause)).toBeInstanceOf(Interpreter.InterpreterError)
      expect(Cause.squash(polled.exit.cause)).toMatchObject({ code: scenario.refusal, flow: tag, node: "root" })
      // The journal says why the run settled.
      const refused = resumed.decisions.filter((decision) => decision.decision === "payload-changed")
      expect(refused).toEqual(
        scenario.refusal === "payload_changed"
          ? [expect.objectContaining({ decision: "payload-changed", status: "failed", code: "payload_changed" })]
          : []
      )
    } finally {
      await PersistentDatabase.remove(filename)
      await rm(root, { recursive: true, force: true })
    }
  }
)
