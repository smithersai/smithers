/**
 * A tab's run reads (`BrowserEngine.inspect` and `list`) against a real
 * leader over Node's own Web Locks and `BroadcastChannel`: the leader reads
 * its engine's tables through `RunInspection`, and the tab decodes the reply.
 */
import { describe, expect, it } from "@effect/vitest"
import { RunInspection } from "@smthrs/engine-store"
import { Action, Flow, Interpreter, RunMetrics } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import { BrowserEngine, BrowserRuntime, TabChannel } from "../src/index.ts"
import * as Protocol from "../src/internal/Protocol.ts"
import * as Engines from "./fixtures/Engines.ts"
import { flows, Steps } from "./fixtures/Flows.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

const HIDDEN = "plain-hidden-value-42"

const Produce = Action.make("run-reads/Produce", { payload: { size: Schema.Number }, success: Schema.String })
const Count = Action.make("run-reads/Count", { payload: {}, success: Schema.Number })

/** A flow whose payload holds a `Redacted` field and whose step answers more than 16 KiB. */
const Secretive = Flow.make("run-reads/Secretive", {
  payload: { opaque: Schema.Redacted(Schema.String), size: Schema.Number },
  success: Schema.String,
  body: Node.capture({}, ({ size }) => Produce.call({ size }))
})

/** A flow whose step reads the engine's own runs: `RunInspection` is part of the engine host. */
const Lister = Flow.make("run-reads/Lister", {
  payload: {},
  success: Schema.Number,
  body: Node.capture({}, () => Count.call({}))
})

/** A flow that runs `Lister` as its child. */
const Wrapper = Flow.make("run-reads/Wrapper", {
  payload: {},
  success: Schema.Number,
  body: Node.capture({}, () => Lister.child({}))
})

const SENTINEL = "sentinel-7f3a9c-never-shown"

const Sealed = Schema.Struct({
  seal: Schema.Redacted(Schema.String),
  nested: Schema.Struct({ list: Schema.Array(Schema.Redacted(Schema.String)) })
})
const Seal = Action.make("run-reads/Seal", { payload: {}, success: Sealed })

/** A flow whose input, step output and result each carry `Redacted` values. */
const Vault = Flow.make("run-reads/Vault", {
  payload: { opaque: Schema.Redacted(Schema.String) },
  success: Sealed,
  body: Node.capture({}, () => Seal.call({}))
})

const registration = Layer.mergeAll(
  Seal.toLayer(() => Effect.succeed({ seal: Redacted.make(SENTINEL), nested: { list: [Redacted.make(SENTINEL)] } })),
  Interpreter.layer(Vault, { callbackIdentity: "stable" }),
  Produce.toLayer(({ size }) => Effect.succeed("x".repeat(size))),
  Count.toLayer(() =>
    Effect.flatMap(RunInspection.RunInspection, (reads) => reads.list({ roots: false })).pipe(
      Effect.map((page) => page.runs.length),
      Effect.orDie
    )
  ),
  Interpreter.layer(Secretive, { callbackIdentity: "stable" }),
  Interpreter.layer(Lister, { callbackIdentity: "stable" }),
  Interpreter.layer(Wrapper, { callbackIdentity: "stable" })
).pipe(Layer.provideMerge(Action.layerImplementations))

/** A leader over a fresh store serving the fixture flows, and a tab beside it. */
const setup = Effect.gen(function*() {
  const name = Engines.name()
  const database = yield* MemorySqlite.open
  yield* Engines.leader(name, Engines.engine(name, database, Engines.steps()))
  const engine = yield* Engines.tab(name)
  return { name, database, engine }
})

describe("BrowserEngine.inspect", () => {
  it.live("reads a finished run, its steps and its journal, a page at a time, and records it without values", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(Effect.gen(function*() {
      const { engine } = yield* setup
      yield* engine.start(Steps, { executionId: "steps-1", payload: { prefix: "private-prefix" } }).pipe(
        RunMetrics.withOrigin({ door: "button", actor: "person" })
      )
      expect(yield* engine.result(Steps, "steps-1")).toEqual(Exit.succeed("private-prefix:three"))

      const inspection = yield* engine.inspect("steps-1")
      // How it started crosses the wire with it: the door and actor kind the tab gave.
      expect(inspection.run).toMatchObject({
        runId: "steps-1",
        flowName: Steps._tag,
        status: "completed",
        origin: { door: "button", actor: "person" }
      })
      expect((yield* engine.list({})).runs.find((run) => run.runId === "steps-1")?.origin)
        .toEqual({ door: "button", actor: "person" })
      expect(JSON.parse(inspection.run.input.text)).toEqual({ prefix: "private-prefix" })
      expect(inspection.steps.filter((step) => step.action === "browser-test/Step").map((step) => step.output?.text))
        .toEqual(["\"private-prefix:one\"", "\"private-prefix:two\"", "\"private-prefix:three\""])
      const all = inspection.journal.events.map((event) => event.seq)
      expect(all.length).toBeGreaterThan(4)
      expect(inspection.run.lastSeq).toBe(all.at(-1))

      const first = yield* engine.inspect("steps-1", { limit: 2 })
      expect(first.journal.events.map((event) => event.seq)).toEqual(all.slice(0, 2))
      expect(first.journal.hasMore).toBe(true)
      const rest = yield* engine.inspect("steps-1", { afterSeq: first.journal.nextSeq })
      expect(rest.journal.events.map((event) => event.seq)).toEqual(all.slice(2))
    })).pipe(
      Effect.scoped,
      Effect.andThen(Effect.sync(() => {
        const lines = telemetry.lines("run.inspect").map((line) => line.annotations)
        expect(lines).toHaveLength(3)
        expect(lines[0]).toMatchObject({ host: "local", outcome: "read", clipped: 0 })
        expect(lines[0]!.events).toBeGreaterThan(4)
        expect(lines[0]!.bytes).toBeGreaterThan(0)
        expect(telemetry.named("run.inspect")).toHaveLength(3)
        expect(telemetry.count(BrowserRuntime.requests, { request: "Inspect", outcome: "replied" })).toBe(3)
        expect(Telemetry.dump(telemetry)).not.toContain("private-prefix")
      }))
    )
  })

  it.live("refuses a run the engine never held, and a run it cannot read, by the failure's tag alone", () => {
    const telemetry = Telemetry.make()
    return telemetry.observed(Effect.gen(function*() {
      const { database, engine } = yield* setup
      expect(yield* engine.inspect("never").pipe(Effect.flip)).toEqual(
        new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/engine-store/RunNotFound" })
      )
      // The leader has migrated the store once it answered; a row no read can decode is refused, not guessed at.
      yield* Effect.flatMap(
        SqlClient.SqlClient,
        (sql) =>
          sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('broken', 'pending', 1, '{}')`
      ).pipe(Effect.provide(MemorySqlite.over(database)))
      expect(yield* engine.inspect("broken").pipe(Effect.flip)).toEqual(
        new BrowserEngine.RequestRefused({ request: "Inspect", error: "@smthrs/run-store/RunStoreError" })
      )
      expect(yield* engine.list().pipe(Effect.flip)).toMatchObject({ request: "List" })
    })).pipe(
      Effect.scoped,
      Effect.andThen(Effect.sync(() => {
        expect(telemetry.lines("run.inspect").map((line) => line.annotations.outcome)).toEqual(["not_found", "failed"])
        expect(telemetry.count(BrowserRuntime.requests, { request: "Inspect", outcome: "refused" })).toBe(2)
      }))
    )
  })

  it.live("refuses a reply it cannot read as SchemaError", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const engine = yield* Engines.tab(name)
      // A leader of another build: it answers every read with something that isn't one.
      const stranger = yield* Effect.flatMap(TabChannel.TabChannel, (channels) => channels.open(name)).pipe(
        Effect.provide(TabChannel.layer)
      )
      const inbox = yield* stranger.subscribe
      yield* Stream.fromQueue(inbox).pipe(
        Stream.runForEach((input) => {
          const message = Protocol.decode(input)
          return message?._tag === "Inspect" || message?._tag === "List"
            ? stranger.post(
              Protocol.encode({ _tag: "Replied", client: message.client, id: message.id, result: { runs: 1 } })
            )
            : Effect.void
        }),
        Effect.forkChild
      )
      yield* stranger.post(Protocol.encode({ _tag: "Leader" }))
      expect(yield* engine.inspect("x").pipe(Effect.flip)).toEqual(
        new BrowserEngine.RequestRefused({ request: "Inspect", error: "SchemaError" })
      )
      expect(yield* engine.list({ limit: 1 }).pipe(Effect.flip)).toEqual(
        new BrowserEngine.RequestRefused({ request: "List", error: "SchemaError" })
      )
    }).pipe(Effect.scoped))
})

describe("BrowserEngine.Inspection and RunList", () => {
  it.live("decode a run read that arrived as JSON from elsewhere, as inspect and list answer it; refuse anything else", () =>
    Effect.gen(function*() {
      const { engine } = yield* setup
      yield* engine.start(Steps, { executionId: "wire-1", payload: { prefix: "w" } })
      yield* engine.result(Steps, "wire-1")
      const read = yield* engine.inspect("wire-1")
      const listed = yield* engine.list()
      // As a server would send them: the engine's own reads, through JSON.
      const decodeInspection = Schema.decodeUnknownEffect(BrowserEngine.Inspection)
      const decodeList = Schema.decodeUnknownEffect(BrowserEngine.RunList)
      expect(yield* decodeInspection(JSON.parse(JSON.stringify(read)))).toEqual(read)
      expect(yield* decodeList(JSON.parse(JSON.stringify(listed)))).toEqual(listed)
      expect((yield* decodeInspection({ ...read, journal: { events: "none" } }).pipe(Effect.flip))._tag).toBe(
        "SchemaError"
      )
      expect((yield* decodeList({ runs: 1 }).pipe(Effect.flip))._tag).toBe("SchemaError")
    }).pipe(Effect.scoped))
})

describe("BrowserEngine.list", () => {
  it.live("lists runs newest first, a page at a time, roots unless asked for every run", () =>
    Effect.gen(function*() {
      const { engine } = yield* setup
      for (const id of ["a", "b", "c"]) {
        yield* engine.start(Steps, { executionId: `list-${id}`, payload: { prefix: id } })
        yield* engine.result(Steps, `list-${id}`)
      }
      const page = yield* engine.list({ limit: 2 })
      expect(page.runs.map((run) => run.runId)).toEqual(["list-c", "list-b"])
      const next = yield* engine.list({ limit: 2, cursor: page.cursor! })
      expect(next).toMatchObject({ runs: [{ runId: "list-a", status: "completed" }], cursor: null })
      expect((yield* engine.list({ roots: false })).runs).toHaveLength(3)
    }).pipe(Effect.scoped))
})

describe("the engine's run reads", () => {
  it.live("never release a Redacted value through the worker protocol, at any depth", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const served = [Vault]
      yield* Engines.leader(
        name,
        BrowserRuntime.layer({ name, flows: served }, registration).pipe(Layer.provide(MemorySqlite.layer)),
        served
      )
      const engine = yield* Engines.tab(name)
      yield* engine.start(Vault, { executionId: "vault-1", payload: { opaque: Redacted.make(SENTINEL) } })
      expect(Exit.isSuccess(yield* engine.result(Vault, "vault-1"))).toBe(true)

      const inspection = yield* engine.inspect("vault-1")
      expect(JSON.stringify(inspection)).not.toContain(SENTINEL)
      const shown = { seal: "<redacted>", nested: { list: ["<redacted>"] } }
      expect(JSON.parse(inspection.run.input.text)).toEqual({ opaque: "<redacted>" })
      expect(JSON.parse(inspection.run.result!.text)).toEqual(shown)
      const seal = inspection.steps.find((step) => step.action === Seal.name)!
      expect(JSON.parse(seal.output!.text)).toEqual(shown)
      expect(seal.attempts.map((attempt) => JSON.parse(attempt.outcome!.text))).toEqual([shown])
      const settled = inspection.journal.events.filter((event) =>
        event.eventType === "flows.engine.node-settled" && event.payload.text.includes(Seal.name)
      )
      expect(settled.map((event) => JSON.parse(JSON.parse(event.payload.text).result.preview))).toEqual([shown])
    }).pipe(Effect.scoped))

  it.live("render a run's payload through its flow, and serve a registered flow that reads them", () =>
    Effect.gen(function*() {
      const name = Engines.name()
      const served = [...flows, Secretive, Lister, Wrapper]
      const engineLayer = BrowserRuntime.layer({ name, flows: served }, registration).pipe(
        Layer.provide(MemorySqlite.layer)
      )
      yield* Engines.leader(name, engineLayer, served)
      const engine = yield* Engines.tab(name)
      yield* engine.start(Secretive, {
        executionId: "secret-1",
        payload: { opaque: Redacted.make(HIDDEN), size: 20_000 }
      })
      expect(Exit.isSuccess(yield* engine.result(Secretive, "secret-1"))).toBe(true)

      const inspection = yield* engine.inspect("secret-1")
      expect(JSON.stringify(inspection)).not.toContain(HIDDEN)
      expect(JSON.parse(inspection.run.input.text)).toEqual({ opaque: "<redacted>", size: 20_000 })
      expect(inspection.run.result).toMatchObject({ clipped: true, bytes: 20_002 })

      yield* engine.start(Lister, { executionId: "lister-1", payload: {} })
      expect(yield* engine.result(Lister, "lister-1")).toEqual(Exit.succeed(2))

      // A run's children are the runs it started, each with its own input and result.
      yield* engine.start(Wrapper, { executionId: "wrapper-1", payload: {} })
      expect(yield* engine.result(Wrapper, "wrapper-1")).toEqual(Exit.succeed(4))
      const wrapper = yield* engine.inspect("wrapper-1")
      expect(wrapper.children).toMatchObject([{
        flowName: Lister._tag,
        parentRunId: "wrapper-1",
        result: { text: "4" }
      }])
    }).pipe(Effect.scoped))
})
