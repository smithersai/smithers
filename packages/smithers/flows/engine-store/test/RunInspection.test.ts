/**
 * `RunInspection` over a journal the real engine wrote: one fixture, read on
 * whichever store the matrix selects (SQLite by default, PostgreSQL under
 * `SMITHERS_TEST_PG_URL`).
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, FlowRuntime, Interpreter, RunMetrics } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as RunInspection from "../src/RunInspection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { withCrypto } from "./Sha256.ts"

const CREDENTIAL = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"
const HIDDEN = "plain-hidden-value-42"
const PROVIDER_TEXT = "upstream said: quota exhausted for org 1234"

class Refused extends Schema.TaggedError<Refused>()("inspection/Refused", { message: Schema.String }) {}

const Echo = Action.make("inspection/Echo", {
  payload: { token: Schema.String },
  success: Schema.Struct({ token: Schema.String, length: Schema.Number })
})
const Big = Action.make("inspection/Big", { payload: { size: Schema.Number }, success: Schema.String })
const Fails = Action.make("inspection/Fails", { payload: {}, success: Schema.String, error: Refused })
const Gate = Action.make("inspection/Gate", { payload: { label: Schema.String }, success: Schema.String })

const Child = Flow.make("inspection/Child", {
  payload: { n: Schema.Number },
  success: Schema.Number,
  body: Node.capture(
    {},
    ({ n }) => Echo.call({ token: `child-${n}` }).pipe(Node.map(Node.capture({}, (r) => r.length)))
  )
})

const Root = Flow.make("inspection/Root", {
  payload: { token: Schema.String, opaque: Schema.Redacted(Schema.String) },
  success: Schema.Number,
  body: Node.capture({}, ({ token }) =>
    Echo.call({ token }).pipe(
      Node.andThen(Big.call({ size: 20 * 1024 })),
      Node.andThen(Child.child({ n: 3 }))
    ))
})

const Failing = Flow.make("inspection/Failing", {
  payload: {},
  success: Schema.String,
  error: Refused,
  body: Node.capture({}, () => Fails.call({}))
})

const Gated = Flow.make("inspection/Gated", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () =>
    Gate.call({ label: "one" }).pipe(
      Node.andThen(Gate.call({ label: "two" })),
      Node.andThen(Gate.call({ label: "three" }))
    ))
})

const SENTINEL = "sentinel-7f3a9c-never-shown"

/** A step whose success holds `Redacted` values at depth. */
const Vault = Action.make("inspection/Vault", {
  payload: {},
  success: Schema.Struct({
    seal: Schema.Redacted(Schema.String),
    nested: Schema.Struct({ list: Schema.Array(Schema.Redacted(Schema.String)) })
  })
})

/** Reachable only through `Sealed`'s child boundary: the reads find it on their own. */
const SealedChild = Flow.make("inspection/SealedChild", {
  payload: {},
  success: Schema.Struct({ kept: Schema.Redacted(Schema.String) }),
  body: Node.capture({}, () => Vault.call({}).pipe(Node.map(Node.capture({}, (vault) => ({ kept: vault.seal })))))
})

/** A run whose input, a step's output, a child's result and its own result each carry a `Redacted` value. */
const Sealed = Flow.make("inspection/Sealed", {
  payload: { opaque: Schema.Redacted(Schema.String) },
  success: Schema.Struct({ kept: Schema.Redacted(Schema.String) }),
  body: Node.capture({}, () => Vault.call({}).pipe(Node.andThen(SealedChild.child({}))))
})

/** A value that decodes to something with no JSON form. */
class Bomb {
  toJSON(): never {
    throw new Error("no JSON form")
  }
}
const Detonate = Action.make("inspection/Detonate", {
  payload: {},
  success: Schema.String.pipe(
    Schema.decodeTo(
      Schema.instanceOf(Bomb),
      SchemaTransformation.transform({ decode: () => new Bomb(), encode: () => "bomb" })
    )
  )
})
const Tally = Action.make("inspection/Tally", { payload: {}, success: Schema.BigInt })
const Explosive = Flow.make("inspection/Explosive", {
  payload: {},
  success: Schema.Number,
  body: Node.capture(
    {},
    () => Detonate.call({}).pipe(Node.andThen(Tally.call({})), Node.map(Node.capture({}, () => 1)))
  )
})

/** A flow whose body reads its real input to plan: the reads skip its plan. */
const Unplannable = Flow.make("inspection/Unplannable", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: (payload) => {
    if (typeof payload.label !== "string") throw new Error("needs its real input")
    return Gate.call({ label: payload.label })
  }
})

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "inspection" as never, changeId: "inspection" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** The real engine over the matrix's store, every fixture flow registered, and the reads beside it. */
const runtime = (gate: (label: string) => Effect.Effect<string>) => {
  const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
  const stores = Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(Layer.provideMerge(database))
  const engine = EngineStore.layer({ owner: { hostId: "inspection" }, journalSource: "inspection-engine" }).pipe(
    Layer.provide(OwnerIdentity.layer),
    Layer.provideMerge(Layer.mergeAll(stores, StepBoundary.layerUnsupported, jj))
  )
  const steps = Layer.mergeAll(
    Echo.toLayer(({ token }) => Effect.succeed({ token, length: token.length })),
    Big.toLayer(({ size }) => Effect.succeed("é".repeat(size / 2))),
    Fails.toLayer(() => Effect.fail(new Refused({ message: PROVIDER_TEXT }))),
    Gate.toLayer(({ label }) => gate(label)),
    Vault.toLayer(() =>
      Effect.succeed({
        seal: Redacted.make(SENTINEL),
        nested: { list: [Redacted.make(SENTINEL), Redacted.make(SENTINEL)] }
      })
    )
  )
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(Root, steps),
    Interpreter.layerWithImplementations(Child, steps),
    Interpreter.layerWithImplementations(Failing, steps),
    Interpreter.layerWithImplementations(Gated, steps),
    Interpreter.layerWithImplementations(Sealed, steps),
    Interpreter.layerWithImplementations(SealedChild, steps)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(
      RunInspection.layerWith({ flows: [Root, Child, Failing, Gated, Sealed, Explosive, Unplannable] })
    ),
    Layer.provideMerge(engine)
  )
}

const run = <A, E>(
  body: Effect.Effect<
    A,
    E,
    FlowRuntime.FlowRuntime | RunInspection.RunInspection | Journal.Journal | SqlClient.SqlClient
  >,
  gate: (label: string) => Effect.Effect<string> = Effect.succeed
) => Effect.runPromise(withCrypto(Effect.scoped(body.pipe(Effect.provide(runtime(gate))))))

const flushed = Effect.flatMap(Journal.Journal, (journal) => journal.flush)

const executeRoot = (executionId: string) =>
  Effect.flatMap(
    FlowRuntime.FlowRuntime,
    (engine) => engine.execute(Root, { executionId, payload: { token: CREDENTIAL, opaque: Redacted.make(HIDDEN) } })
  )

/** A node settled clean by `action`, with `preview` as its writer cut it or not. */
const settledAs = (nodeId: string, action: string, preview: string, truncated: boolean) => ({
  nodeId,
  outcome: "built",
  attempts: 1,
  action,
  result: { preview, bytes: 900, truncated }
})

describe("RunInspection.inspect", () => {
  it("reads a finished run: redacted input, steps with attempts and clipped output, its child, and its journal", () =>
    run(Effect.gen(function*() {
      expect(yield* executeRoot("root-1")).toBe("child-3".length)
      yield* flushed
      const reads = yield* RunInspection.RunInspection
      const inspection = yield* reads.inspect("root-1")
      const everything = JSON.stringify(inspection)

      // Nothing credential-shaped and no Redacted field leaves the read.
      expect(everything).not.toContain(CREDENTIAL)
      expect(everything).not.toContain(HIDDEN)
      expect(inspection.run).toMatchObject({
        runId: "root-1",
        flowName: Root._tag,
        status: "completed",
        parentRunId: null,
        cancelRequestedAtMs: null,
        waiting: null
      })
      expect(JSON.parse(inspection.run.input.text)).toMatchObject({ token: "[REDACTED]" })
      expect(inspection.run.result).toEqual({ text: "7", bytes: 1, clipped: false })
      expect(inspection.run.lastSeq).toBe(inspection.journal.events.at(-1)!.seq)

      const echo = inspection.steps.find((step) => step.action === Echo.name)!
      expect(echo).toMatchObject({ kind: "ActionCall", status: "completed" })
      expect(echo.settledAtMs).toBeGreaterThanOrEqual(echo.scheduledAtMs)
      expect(echo.attempts).toHaveLength(1)
      expect(echo.attempts[0]).toMatchObject({ attempt: 1, state: "succeeded", error: null })
      expect(JSON.parse(echo.output!.text)).toEqual({ token: "[REDACTED]", length: CREDENTIAL.length })

      // A value over 16 KiB is cut at a character boundary, with its whole size.
      const big = inspection.steps.find((step) => step.action === Big.name)!
      expect(big.output).toMatchObject({ clipped: true })
      expect(new TextEncoder().encode(big.output!.text).length).toBeLessThanOrEqual(RunInspection.valueLimitBytes)
      expect(big.output!.bytes).toBeGreaterThan(RunInspection.valueLimitBytes)
      expect(big.output!.text.endsWith("é")).toBe(true)

      // The child boundary is a step, and its run is a child with its own input and result.
      const boundary = inspection.steps.find((step) => step.action === Child._tag)!
      expect(boundary.status).toBe("completed")
      expect(inspection.children).toHaveLength(1)
      expect(inspection.children[0]).toMatchObject({
        flowName: Child._tag,
        status: "completed",
        parentRunId: "root-1",
        input: { text: "{\"n\":3}", clipped: false },
        result: { text: "7" }
      })

      // The whole journal in one page, ascending, every payload redacted.
      const seqs = inspection.journal.events.map((event) => event.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(inspection.journal).toMatchObject({ afterSeq: -1, hasMore: false, nextSeq: seqs.at(-1) })
      expect(inspection.journal.events.map((event) => event.eventType)).toContain("flows.engine.run-decision")

      // The engine's own record of the payload is encoded and unredacted, for a re-run inside the engine.
      expect(yield* reads.payload("root-1")).toEqual({
        flowName: Root._tag,
        payload: { token: CREDENTIAL, opaque: expect.anything() }
      })
    })))

  it("never releases a Redacted value at any depth: input, step outputs, attempts, the child, the result, the journal", () =>
    run(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const result = yield* engine.execute(Sealed, {
        executionId: "sealed-1",
        payload: { opaque: Redacted.make(SENTINEL) }
      })
      expect(Redacted.value(result.kept)).toBe(SENTINEL)
      yield* flushed
      const reads = yield* RunInspection.RunInspection
      const sealed = yield* reads.inspect("sealed-1")
      const child = yield* reads.inspect(sealed.children[0]!.runId)
      for (const inspection of [sealed, child]) {
        const everything = JSON.stringify(inspection)
        expect(everything).not.toContain(SENTINEL)
        for (const event of inspection.journal.events) expect(event.payload.text).not.toContain(SENTINEL)
      }
      const shown = { seal: "<redacted>", nested: { list: ["<redacted>", "<redacted>"] } }
      expect(JSON.parse(sealed.run.input.text)).toEqual({ opaque: "<redacted>" })
      expect(JSON.parse(sealed.run.result!.text)).toEqual({ kept: "<redacted>" })
      expect(JSON.parse(sealed.children[0]!.result!.text)).toEqual({ kept: "<redacted>" })
      for (const inspection of [sealed, child]) {
        const vault = inspection.steps.find((step) => step.action === Vault.name)!
        expect(JSON.parse(vault.output!.text)).toEqual(shown)
        expect(vault.attempts.map((attempt) => JSON.parse(attempt.outcome!.text))).toEqual([shown])
        const settled = inspection.journal.events.find((event) =>
          event.eventType === "flows.engine.node-settled" && event.payload.text.includes(Vault.name)
        )!
        expect(JSON.parse(JSON.parse(settled.payload.text).result.preview)).toEqual(shown)
      }
      // The map that picks the token out passes on a step's value: withheld.
      expect(child.steps.find((step) => step.kind === "Map")?.output?.text).toBe(
        JSON.stringify(RunInspection.withheldMarker)
      )
    })))

  it("without the run's flow, reads its values as stored, behind the redactor's rules alone", () =>
    run(Effect.gen(function*() {
      yield* executeRoot("stored-1")
      yield* flushed
      const reads = yield* RunInspection.make()
      const inspection = yield* reads.inspect("stored-1")
      expect(JSON.parse(inspection.run.input.text)).toEqual({ token: "[REDACTED]", opaque: HIDDEN })
      expect(inspection.run.result).toEqual({ text: "7", bytes: 1, clipped: false })
    })))

  it("withholds a stored value its flow no longer decodes, and reads a run of an unknown flow as stored", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const drifted = JSON.stringify({ version: 1, flowName: Root._tag, payload: { count: 7 } })
      const stranger = JSON.stringify({
        version: 1,
        flowName: "inspection/Stranger",
        payload: { value: "x" },
        result: { _tag: "Suspended" }
      })
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('drifted', 'pending', 1, ${drifted}), ('stranger', 'suspended', 2, ${stranger})`
      const reads = yield* RunInspection.RunInspection
      expect((yield* reads.inspect("drifted")).run.input.text).toBe(JSON.stringify(RunInspection.withheldMarker))
      const unknown = yield* reads.inspect("stranger")
      expect(unknown.run).toMatchObject({
        input: { text: "{\"value\":\"x\"}" },
        result: { text: "{\"_tag\":\"Suspended\"}" }
      })
      expect(unknown.run.lastSeq).toBe(-1)
      expect(unknown.steps).toEqual([])
    })))

  it("folds a journal another writer kept: settlements without scheduling, every outcome, and what it can't read", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const state = JSON.stringify({ version: 1, flowName: "inspection/Stranger", payload: {} })
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, waiting_reason, waiting_wake_at_ms)
        VALUES ('kept', 'suspended', 1, ${state}, 'event', 99)`
      const events: ReadonlyArray<readonly [string, unknown]> = [
        ["flows.engine.node-scheduled", { nodeId: "a", kind: "ActionCall", attempt: 1 }],
        ["flows.engine.node-scheduled", { nodeId: "a", kind: "ActionCall", attempt: 1 }],
        // Scheduled again while open: the same step.
        ["flows.engine.node-scheduled", { nodeId: "a", kind: "ActionCall", attempt: 2, action: "x/A" }],
        ["flows.engine.node-scheduled", { nope: true }],
        ["flows.engine.node-settled", { nope: true }],
        ["flows.engine.node-settled", {
          nodeId: "a",
          outcome: "deferred",
          attempts: 1,
          stepKeyDigests: ["unrecorded"]
        }],
        ["flows.engine.node-settled", { nodeId: "b", outcome: "skipped", attempts: 0, action: "x/B" }],
        [
          "flows.engine.node-settled",
          {
            nodeId: "c",
            outcome: "failed",
            attempts: 1,
            result: { preview: "{\"_tag\":\"x/C\",\"mes", bytes: 900, truncated: true }
          }
        ],
        [
          "flows.engine.node-settled",
          { nodeId: "d", outcome: "clean", attempts: 0, result: { preview: CREDENTIAL, bytes: 60, truncated: false } }
        ],
        ["custom.event", [1, CREDENTIAL]],
        // Known actions, shown through their schemas; a cut, unreadable or undecodable one with a secret is withheld.
        ["flows.engine.node-settled", settledAs("e", Vault.name, `{"seal":"${SENTINEL}`, true)],
        ["flows.engine.node-settled", settledAs("f", Vault.name, `{"seal":"${SENTINEL}`, false)],
        ["flows.engine.node-settled", settledAs("g", Big.name, "\"ééé", true)],
        [
          "flows.engine.node-settled",
          settledAs("h", Echo.name, JSON.stringify({ token: CREDENTIAL, length: 3 }), false)
        ],
        ["flows.engine.node-settled", settledAs("i", Detonate.name, "\"bomb\"", false)],
        [
          "flows.engine.node-settled",
          settledAs("j", Vault.name, JSON.stringify({ seal: SENTINEL, nested: { list: [SENTINEL] } }), false)
        ],
        ["flows.engine.node-settled", settledAs("k", Echo.name, "{\"wrong\":1}", false)],
        ["flows.engine.node-settled", settledAs("l", Tally.name, "\"12345678901234567890\"", false)],
        [
          "flows.engine.run-decision",
          {
            decision: "transitioned",
            state: {
              version: 1,
              flowName: Sealed._tag,
              payload: { opaque: SENTINEL },
              result: { _tag: "Complete", exit: { _tag: "Success", value: { kept: SENTINEL } } }
            }
          }
        ],
        ["flows.engine.run-decision", { decision: "created", state: { version: 1, flowName: Root._tag, payload: {} } }]
      ]
      for (const [seq, [eventType, payload]] of events.entries()) {
        yield* sql`INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES ('kept', ${seq}, ${`kept-${seq}`}, 'kept', ${seq}, ${100 + seq}, ${eventType}, ${
          JSON.stringify(payload)
        }, '{}')`
      }
      const inspection = yield* (yield* RunInspection.RunInspection).inspect("kept")
      const everything = JSON.stringify(inspection)
      expect(everything).not.toContain(CREDENTIAL)
      expect(everything).not.toContain(SENTINEL)
      expect(inspection.run).toMatchObject({ waiting: { kind: "signal", reason: "event", wakeAtMs: 99 }, lastSeq: 19 })
      expect(inspection.steps.slice(0, 4).map(({ action, nodeId, seq, status }) => ({ nodeId, action, status, seq })))
        .toEqual([
          { nodeId: "a", action: "x/A", status: "waiting", seq: 0 },
          { nodeId: "b", action: "x/B", status: "skipped", seq: 6 },
          { nodeId: "c", action: null, status: "failed", seq: 7 },
          { nodeId: "d", action: null, status: "completed", seq: 8 }
        ])
      const output = (nodeId: string) => inspection.steps.find((step) => step.nodeId === nodeId)!.output
      const withheld = JSON.stringify(RunInspection.withheldMarker)
      expect(inspection.steps[0]!.attempts).toEqual([])
      expect(output("c")).toEqual({ text: "{\"failure\":\"failed\"}", bytes: 20, clipped: false })
      // A node with no action passes on a step's value: it is withheld.
      expect(output("d")!.text).toBe(withheld)
      expect(output("e")!.text).toBe(withheld)
      expect(output("f")!.text).toBe(withheld)
      expect(output("g")).toEqual({ text: "\"ééé", bytes: 900, clipped: true })
      expect(JSON.parse(output("h")!.text)).toEqual({ token: "[REDACTED]", length: 3 })
      expect(output("i")!.text).toBe(withheld)
      expect(JSON.parse(output("j")!.text)).toEqual({ seal: "<redacted>", nested: { list: ["<redacted>"] } })
      expect(output("k")!.text).toBe(withheld)
      expect(output("l")!.text).toBe("\"12345678901234567890\"")
      const event = (seq: number) => JSON.parse(inspection.journal.events[seq]!.payload.text)
      expect(event(7).result).toEqual({ preview: "{\"failure\":\"failed\"}", bytes: 900, truncated: false })
      expect(event(9)).toEqual([1, "[REDACTED_API_KEY]"])
      expect(event(15).result).toEqual({
        preview: JSON.stringify({ seal: "<redacted>", nested: { list: ["<redacted>"] } }),
        bytes: 900,
        truncated: false
      })
      expect(event(18).state).toMatchObject({
        payload: { opaque: "<redacted>" },
        result: { exit: { value: { kept: "<redacted>" } } }
      })
      expect(event(19).state.payload).toBe(RunInspection.withheldMarker)
    })))

  it("reduces a failure to its closed code: no message, no provider text", () =>
    run(Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Effect.flatMap(FlowRuntime.FlowRuntime, (engine) =>
          engine.execute(Failing, { executionId: "failing-1", payload: {} }))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      yield* flushed
      const inspection = yield* (yield* RunInspection.RunInspection).inspect("failing-1")
      expect(JSON.stringify(inspection)).not.toContain(PROVIDER_TEXT)
      expect(inspection.run.status).toBe("failed")
      expect(JSON.parse(inspection.run.result!.text)).toEqual({ failure: "inspection/Refused" })
      const failed = inspection.steps.find((step) =>
        step.action === Fails.name
      )!
      expect(failed.status).toBe("failed")
      expect(failed.attempts.map((attempt) => attempt.error)).toContain("inspection/Refused")
    })))

  it("pages the journal by sequence without gaps or repeats while the run appends", () => {
    const opened = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    return run(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const reads = yield* RunInspection.RunInspection
        const running = yield* Effect.forkChild(engine.execute(Gated, { executionId: "gated-1", payload: {} }))
        yield* Deferred.await(opened)
        yield* flushed
        const seen: Array<number> = []
        let after = -1
        const page = Effect.gen(function*() {
          const { journal, run } = yield* reads.inspect("gated-1", { afterSeq: after, limit: 2 })
          expect(journal.events.length).toBeLessThanOrEqual(2)
          seen.push(...journal.events.map((event) => event.seq))
          after = journal.nextSeq
          return { journal, run }
        })
        const first = yield* page
        expect(first.run.status).toBe("running")
        expect(first.journal.hasMore).toBe(true)
        yield* page
        yield* Deferred.succeed(release, undefined)
        expect(yield* Fiber.join(running)).toBe("three")
        yield* flushed
        let more = true
        while (more) more = (yield* page).journal.hasMore
        // An empty page past the end keeps its cursor.
        const end = yield* reads.inspect("gated-1", { afterSeq: after })
        expect(end.journal).toMatchObject({ events: [], nextSeq: after, hasMore: false })

        const all = (yield* reads.inspect("gated-1")).journal.events.map((event) => event.seq)
        expect(seen).toEqual(all)
        expect(new Set(seen).size).toBe(seen.length)
      }),
      (label) =>
        label === "two"
          ? Deferred.succeed(opened, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(label))
          : Effect.succeed(label)
    )
  })

  it("answers RunNotFound for a run the engine never held, for both reads", () =>
    run(Effect.gen(function*() {
      const reads = yield* RunInspection.RunInspection
      expect(yield* Effect.flip(reads.inspect("absent"))).toEqual(new RunInspection.RunNotFound({ runId: "absent" }))
      expect(yield* Effect.flip(reads.payload("absent"))).toEqual(new RunInspection.RunNotFound({ runId: "absent" }))
    })))

  it("fails a stored row it cannot read with RunStoreError, and a store failure the same way", () =>
    run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('broken', 'pending', 1, '{}')`
      const reads = yield* RunInspection.RunInspection
      expect(yield* Effect.flip(reads.inspect("broken"))).toMatchObject({
        _tag: "@smthrs/run-store/RunStoreError",
        code: "decode_failed"
      })
      expect(yield* Effect.flip(reads.list())).toMatchObject({ code: "decode_failed" })
    })))
})

describe("RunInspection.list", () => {
  it("lists runs newest first, a page at a time, roots unless asked for every run", () =>
    run(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      for (const id of ["a", "b", "c"]) yield* engine.execute(Child, { executionId: `list-${id}`, payload: { n: 1 } })
      yield* executeRoot("list-root")
      const reads = yield* RunInspection.RunInspection

      const roots = yield* reads.list()
      expect(roots.runs.map((run) => run.runId)).toEqual(["list-root", "list-c", "list-b", "list-a"])
      expect(roots.cursor).toBeNull()
      expect(roots.runs[0]!.lastSeq).toBeGreaterThan(0)

      const first = yield* reads.list({ limit: 2 })
      expect(first.runs.map((run) => run.runId)).toEqual(["list-root", "list-c"])
      const second = yield* reads.list({ limit: 2, cursor: first.cursor! })
      expect(second.runs.map((run) => run.runId)).toEqual(["list-b", "list-a"])
      expect(second.cursor).toBeNull()

      const everything = yield* reads.list({ roots: false, limit: 500 })
      expect(everything.runs).toHaveLength(5)
      expect(everything.runs.some((run) => run.parentRunId === "list-root")).toBe(true)

      expect(yield* Effect.flip(reads.list({ cursor: "not a cursor" }))).toMatchObject({
        code: "invalid_run",
        method: "RunInspection.list"
      })
    })))

  it("says how each run started: its door and actor kind, a child's as `flow`, none for a run kept before origins", () =>
    run(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* executeRoot("origin-root").pipe(RunMetrics.withOrigin({ door: "button", actor: "person" }))
      yield* engine.execute(Child, { executionId: "origin-plain", payload: { n: 1 } })
      const state = JSON.stringify({ version: 1, flowName: Child._tag, payload: { n: 2 } })
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('origin-old', 'pending', 1, ${state})`
      const reads = yield* RunInspection.RunInspection

      const listed = new Map((yield* reads.list({ roots: false, limit: 500 })).runs.map((run) => [run.runId, run]))
      expect(listed.get("origin-root")!.origin).toEqual({ door: "button", actor: "person" })
      expect(listed.get("origin-plain")!.origin).toEqual({ door: "unknown", actor: "unknown" })
      expect(listed.get("origin-old")!.origin).toBeNull()
      const child = [...listed.values()].find((run) => run.parentRunId === "origin-root")!
      expect(child.origin).toEqual({ door: "flow", actor: "person" })
      // The run's own read says the same.
      expect((yield* reads.inspect("origin-root")).run.origin).toEqual({ door: "button", actor: "person" })
    })))

  it("lists only the runs, or the flows, asked for, newest first, leaving out what the engine never held, within bounds", () =>
    run(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      for (const id of ["a", "b", "c"]) yield* engine.execute(Child, { executionId: `ids-${id}`, payload: { n: 1 } })
      yield* executeRoot("ids-root")
      const reads = yield* RunInspection.RunInspection
      const child = (yield* reads.list({ roots: false, limit: 500 })).runs.find((run) =>
        run.parentRunId === "ids-root"
      )!

      const asked = yield* reads.list({ runIds: ["ids-a", "ids-c", "never-held"] })
      expect(asked.runs.map((run) => run.runId)).toEqual(["ids-c", "ids-a"])
      expect(asked.cursor).toBeNull()
      // A child is a run asked for only once roots are off.
      expect((yield* reads.list({ runIds: [child.runId] })).runs).toEqual([])
      expect((yield* reads.list({ runIds: [child.runId], roots: false })).runs.map((run) => run.runId))
        .toEqual([child.runId])
      // Paged like any list.
      const first = yield* reads.list({ runIds: ["ids-a", "ids-b", "ids-c"], limit: 2 })
      expect(first.runs.map((run) => run.runId)).toEqual(["ids-c", "ids-b"])
      const second = yield* reads.list({ runIds: ["ids-a", "ids-b", "ids-c"], limit: 2, cursor: first.cursor! })
      expect(second.runs.map((run) => run.runId)).toEqual(["ids-a"])
      // By flow: only those flows' runs, with the other filters.
      expect((yield* reads.list({ flows: [Root._tag] })).runs.map((run) => run.runId)).toEqual(["ids-root"])
      expect((yield* reads.list({ flows: [Child._tag, "never/ran"] })).runs.map((run) => run.runId))
        .toEqual(["ids-c", "ids-b", "ids-a"])
      expect((yield* reads.list({ flows: [Child._tag], roots: false })).runs.map((run) => run.runId))
        .toContain(child.runId)
      expect((yield* reads.list({ flows: [Child._tag], runIds: ["ids-b", "ids-root"] })).runs.map((run) => run.runId))
        .toEqual(["ids-b"])
      expect(yield* reads.list({ flows: [] })).toEqual({ runs: [], cursor: null })
      const tooManyFlows = Array.from({ length: RunInspection.maximumListFlows + 1 }, (_, index) => `flow/${index}`)
      expect(yield* Effect.flip(reads.list({ flows: tooManyFlows }))).toMatchObject({ code: "invalid_run" })
      // None asked, none listed; past the bound, refused.
      expect(yield* reads.list({ runIds: [] })).toEqual({ runs: [], cursor: null })
      const tooMany = Array.from({ length: RunInspection.maximumListPage + 1 }, (_, index) => `ids-${index}`)
      expect(yield* Effect.flip(reads.list({ runIds: tooMany }))).toMatchObject({
        code: "invalid_run",
        method: "RunInspection.list"
      })
    })))
})

describe("values", () => {
  it("finds a Redacted value anywhere in a schema", () => {
    expect(RunInspection.holdsRedacted(Schema.String)).toBe(false)
    expect(RunInspection.holdsRedacted(Vault.successSchema)).toBe(true)
    expect(RunInspection.holdsRedacted(Schema.Union([Schema.Number, Schema.Redacted(Schema.Number)]))).toBe(true)
    interface Tree {
      readonly leaf: Redacted.Redacted<string>
      readonly children: ReadonlyArray<Tree>
    }
    const Tree: Schema.Codec<Tree, unknown> = Schema.Struct({
      leaf: Schema.Redacted(Schema.String),
      children: Schema.Array(Schema.suspend((): Schema.Codec<Tree, unknown> => Tree))
    }) as never
    expect(RunInspection.holdsRedacted(Schema.suspend(() => Tree))).toBe(true)
    const Plain: Schema.Codec<unknown, unknown> = Schema.suspend((): Schema.Codec<unknown, unknown> => Plain)
    expect(RunInspection.holdsRedacted(Plain)).toBe(false)
  })

  it("clips at a character boundary and keeps the whole size", () => {
    expect(RunInspection.clip("abc")).toEqual({ text: "abc", bytes: 3, clipped: false })
    const long = "a".repeat(RunInspection.valueLimitBytes - 1) + "€€"
    const clipped = RunInspection.clip(long)
    expect(clipped).toEqual({
      text: "a".repeat(RunInspection.valueLimitBytes - 1),
      bytes: long.length + 4,
      clipped: true
    })
  })

  it("reduces any stored failure to a closed code", () => {
    expect(RunInspection.codeOf([{ _tag: "Fail", error: { _tag: "my/Failure", message: "x" } }])).toBe("my/Failure")
    expect(RunInspection.codeOf([{ _tag: "Die", defect: { message: "secret" } }])).toBe("defect")
    expect(RunInspection.codeOf({ _tag: "Interrupt" })).toBe("interrupted")
    expect(RunInspection.codeOf({ _tag: "has spaces in it" })).toBe("failed")
    expect(RunInspection.codeOf("text")).toBe("failed")
    expect(RunInspection.codeOf({ message: "no tag" })).toBe("failed")
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(RunInspection.codeOf(cycle)).toBe("failed")
  })

  it("redacts, reduces failures and encodes any value", () => {
    expect(RunInspection.valueOf(undefined)).toEqual({ text: "null", bytes: 4, clipped: false })
    expect(JSON.parse(RunInspection.valueOf({ apiKey: "x", nested: [{ _tag: "Die", defect: "secret" }] }).text))
      .toEqual({ apiKey: "[REDACTED]", nested: [{ _tag: "Die", failure: "defect" }] })
    expect(JSON.parse(RunInspection.valueOf({ _tag: "Fail", error: { _tag: "a/B", message: "m" } }).text))
      .toEqual({ _tag: "Fail", failure: "a/B" })
    expect(JSON.parse(RunInspection.valueOf({ exit: { _tag: "Failure", cause: [{ _tag: "Interrupt" }] } }).text))
      .toEqual({ exit: { _tag: "Failure", failure: "interrupted" } })
  })
})
