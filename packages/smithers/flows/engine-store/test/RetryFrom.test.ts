/**
 * Retry from a step (`FlowRuntime.retryFrom`) on the durable engine, over
 * whichever store the matrix selects: SQLite, or PostgreSQL under
 * `SMITHERS_TEST_PG_URL`.
 *
 * Every implementation counts its invocations, so "replayed" is an assertion
 * about bodies that never ran, not about results that look alike: each body
 * answers with its own invocation number, and a replayed step's answer is the
 * number the source run recorded.
 */
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node, type Planned } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Cause, Deferred, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as RetrySource from "../src/internal/RetrySource.ts"
import * as RunInspection from "../src/RunInspection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import { runPromise } from "./Sha256.ts"

// The declarations. Each body answers `name(input)#n`, its n-th invocation.

const Load = Action.make("retry-from/load", { payload: { input: Schema.String }, success: Schema.String })
const Prompt = Action.make("retry-from/prompt", { payload: { loaded: Schema.String }, success: Schema.String })
const Finish = Action.make("retry-from/finish", { payload: { prompted: Schema.String }, success: Schema.String })
const Prep = Action.make("retry-from/prep", { payload: {}, success: Schema.String })
const Fast = Action.make("retry-from/fast", { payload: {}, success: Schema.String })
const Slow = Action.make("retry-from/slow", { payload: {}, success: Schema.String })
const Join = Action.make("retry-from/join", {
  payload: { fast: Schema.String, slow: Schema.String },
  success: Schema.String
})
const Inner = Action.make("retry-from/inner", { payload: { value: Schema.String }, success: Schema.String })
const Wait = Action.make("retry-from/wait", { payload: {}, success: Schema.String })

class Refused extends Schema.TaggedError<Refused>()("retry-from/Refused", {}) {}

const Flaky = Action.make("retry-from/flaky", {
  payload: { loaded: Schema.String },
  success: Schema.String,
  error: Refused,
  retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, nonRetryable: ["retry-from/Refused"] })
})

const gate = DurableDeferred.make("retry-from-gate", { success: Schema.String })

/** load → prompt → finish, each from the one before. */
const Chain = Flow.make("retry-from/chain", {
  payload: { input: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ input }) =>
    Load.call({ input }).pipe(
      Node.bindPlanned(Node.capture({}, (loaded: Planned.Planned<string>) => Prompt.call({ loaded }))),
      Node.bindPlanned(Node.capture({}, (prompted: Planned.Planned<string>) => Finish.call({ prompted })))
    ))
})

/** A later build of `Chain` that dropped the prompt: a changed declaration under the same tag. */
const ChainWithoutPrompt = Flow.make("retry-from/chain", {
  payload: { input: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ input }) =>
    Load.call({ input }).pipe(
      Node.bindPlanned(Node.capture({}, (prompted: Planned.Planned<string>) => Finish.call({ prompted })))
    ))
})

/** prep, then fast and slow at once, then join; with a round budget, which a retry keeps. */
const Fan = Flow.make("retry-from/fan", {
  payload: {},
  success: Schema.String,
  maxRounds: 3,
  body: Node.capture({}, () =>
    Prep.call({}).pipe(
      Node.andThen(Node.all({ fast: Fast.call({}), slow: Slow.call({}) })),
      Node.bindPlanned(
        Node.capture(
          {},
          (both: Planned.Planned<{ readonly fast: string; readonly slow: string }>) =>
            Join.call({ fast: both.fast, slow: both.slow })
        )
      )
    ))
})

const Child = Flow.make("retry-from/child", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ value }) => Inner.call({ value }))
})

/** load → a child → a second child from the first's answer → finish. */
const Nest = Flow.make("retry-from/nest", {
  payload: { input: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ input }) =>
    Load.call({ input }).pipe(
      Node.bindPlanned(Node.capture({}, (loaded: Planned.Planned<string>) => Child.child({ value: loaded }))),
      Node.bindPlanned(Node.capture({}, (first: Planned.Planned<string>) => Child.child({ value: first }))),
      Node.bindPlanned(Node.capture({}, (second: Planned.Planned<string>) => Finish.call({ prompted: second })))
    ))
})

/** load → flaky, which fails the first time → finish. */
const Breaks = Flow.make("retry-from/breaks", {
  payload: { input: Schema.String },
  success: Schema.String,
  error: Refused,
  body: Node.capture({}, ({ input }) =>
    Load.call({ input }).pipe(
      Node.bindPlanned(Node.capture({}, (loaded: Planned.Planned<string>) => Flaky.call({ loaded }))),
      Node.bindPlanned(Node.capture({}, (flaked: Planned.Planned<string>) => Finish.call({ prompted: flaked })))
    ))
})

/** One step that waits on a durable deferred. */
const Gated = Flow.make("retry-from/gated", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Wait.call({}))
})

const flows = [Chain, Fan, Child, Nest, Breaks, Gated] as const

/** How many times each body ran. */
type Counts = Record<string, number>

/** What a case changes about the bodies. */
interface Hooks {
  /** Runs before the prompt body answers. */
  readonly prompt?: ((n: number) => Effect.Effect<void>) | undefined
}

const steps = (counts: Counts, hooks: Hooks, slowStarted: Deferred.Deferred<void>) => {
  const count = (name: string) => (counts[name] = (counts[name] ?? 0) + 1)
  const answer = (name: string, input: string) => Effect.sync(() => `${name}(${input})#${count(name)}`)
  return Layer.mergeAll(
    Load.toLayer(({ input }) => answer("load", input)),
    // Counted on entry, so a prompt that hangs is still an invocation.
    Prompt.toLayer(({ loaded }) =>
      Effect.suspend(() => {
        const n = count("prompt")
        return Effect.as(hooks.prompt?.(n) ?? Effect.void, `prompt(${loaded})#${n}`)
      })
    ),
    Finish.toLayer(({ prompted }) => answer("finish", prompted)),
    Prep.toLayer(() => answer("prep", "")),
    // The fast branch finishes only once the slow one began: the first time,
    // it waits for the slow body to start.
    Fast.toLayer(() =>
      Effect.andThen(counts["fast"] === undefined ? Deferred.await(slowStarted) : Effect.void, answer("fast", ""))
    ),
    Slow.toLayer(() => Effect.andThen(Deferred.succeed(slowStarted, undefined), answer("slow", ""))),
    Join.toLayer(({ fast, slow }) => answer("join", `${fast},${slow}`)),
    Inner.toLayer(({ value }) => answer("inner", value)),
    Flaky.toLayer(({ loaded }) =>
      counts["flaky"] === undefined
        ? Effect.andThen(Effect.sync(() => count("flaky")), Effect.fail(new Refused()))
        : answer("flaky", loaded)
    ),
    Wait.toLayer(() => DurableDeferred.await(gate))
  )
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "retry-from" as never, changeId: "retry-from" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

type Services =
  | FlowRuntime.FlowRuntime
  | RunInspection.RunInspection
  | Journal.Journal
  | SqlClient.SqlClient
  | RunStore.RunStore
  | DurableEngineState.DurableEngineState
  | Action.Implementations
  | Crypto.Crypto

interface Process {
  readonly counts: Counts
  readonly hooks?: Hooks | undefined
  /** The flows this process registers; every fixture flow unless set. */
  readonly flows?: ReadonlyArray<Flow.Any> | undefined
  /** The engine's state store as this process composes it. */
  readonly state?: ((state: DurableEngineState.Service) => DurableEngineState.Service) | undefined
}

/**
 * One engine process over the database `filename` names: its own engine and
 * registrations, the reads beside them. Ending it closes the engine, as a
 * process exit does.
 */
const process = <A, E>(filename: string, options: Process, body: Effect.Effect<A, E, Services>) =>
  Effect.gen(function*() {
    const slowStarted = yield* Deferred.make<void>()
    const state = yield* DurableEngineState.DurableEngineState
    return yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* EngineStore.make({
        owner: { hostId: "retry-from" },
        journalSource: "retry-from",
        isAlive: () => Effect.succeed(false)
      }).pipe(Effect.provide(StepBoundary.layerTest()), Effect.provide(jj))
      const implementations = steps(options.counts, options.hooks ?? {}, slowStarted)
      const registered = (options.flows ?? flows).map((flow) =>
        Interpreter.layerWithImplementations(flow as typeof Chain, implementations as never)
      ).reduce((all, layer) => Layer.merge(all, layer)).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
      )
      return yield* body.pipe(Effect.provide(registered))
    })).pipe(
      Effect.provideService(DurableEngineState.DurableEngineState, options.state?.(state) ?? state)
    )
  }).pipe(
    Effect.provide(RunInspection.layerWith({ flows: [...flows] })),
    Effect.provide(TestStores.layerAt(filename))
    // The registrations erase their layers' types; what is left to provide is `Crypto`.
  ) as unknown as Effect.Effect<A, E, Crypto.Crypto>

const databases: Array<string> = []
afterEach(async () => {
  for (const filename of databases.splice(0)) await PersistentDatabase.remove(filename)
})

/** A fresh database on the matrix's store, removed after the case. */
const database = async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-retry-from-"))
  const filename = PersistentDatabase.filename(join(root, "state.sqlite"))
  databases.push(filename)
  return { filename, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Runs `body` in one process over a fresh database. */
const once = async <A, E>(body: (counts: Counts) => Effect.Effect<A, E, Services>) => {
  const { cleanup, filename } = await database()
  const counts: Counts = {}
  try {
    return await runPromise(process(filename, { counts }, body(counts)))
  } finally {
    await cleanup()
  }
}

const engine = FlowRuntime.FlowRuntime

/** The engine's state store without `copyAttempts`, as storage that cannot copy attempts composes it. */
const withoutCopy = (state: DurableEngineState.Service): DurableEngineState.Service => {
  const { copyAttempts: _, ...rest } = state
  return rest
}

/** Runs `flow` to its settlement under `executionId`, or joins the run there. */
const settle = (flow: Flow.Any, executionId: string, payload: object) =>
  Effect.flatMap(
    engine,
    (runtime) => Effect.exit(runtime.execute(flow as typeof Chain, { executionId, payload } as never))
  )

/** The node `action` dispatched in `runId`, by the run's own node records. */
const nodeOf = (runId: string, action: string) =>
  Effect.gen(function*() {
    yield* Effect.flatMap(Journal.Journal, (journal) => journal.flush)
    const inspection = yield* (yield* RunInspection.RunInspection).inspect(runId)
    return inspection.steps.find((step) => step.action === action)!.nodeId
  })

/** Every node `action` dispatched in `runId`, in the order they were scheduled. */
const nodesOf = (runId: string, action: string) =>
  Effect.gen(function*() {
    yield* Effect.flatMap(Journal.Journal, (journal) => journal.flush)
    const inspection = yield* (yield* RunInspection.RunInspection).inspect(runId)
    return inspection.steps.filter((step) => step.action === action).map((step) => step.nodeId)
  })

/** Retries `source` from `step` as `executionId` through the port. */
const retry = (flow: Flow.Any, source: string, step: string, executionId: string) =>
  Effect.flatMap(engine, (runtime) => runtime.retryFrom!(flow, { source, step, executionId }))

/** The `retry-from` decision a run recorded, if it recorded one. */
const retryDecision = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({
      runId: JournalEvent.RunId.make(runId),
      eventTypes: ["flows.engine.run-decision"],
      limit: 1000
    })
    return page.entries.map((entry) => entry.payload as Record<string, unknown>).find((payload) =>
      payload["decision"] === "retry-from"
    )
  })

/** A run's stored state. */
const stateOf = (runId: string) =>
  Effect.gen(function*() {
    const row = yield* (yield* RunStore.RunStore).get(runId)
    return JSON.parse(row.stateJson) as Record<string, unknown>
  })

/** What a source run holds, to prove a retry left it as it was. */
const snapshotOf = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 10_000 })
    const attempts = yield* sql<{ readonly step_key_digest: string; readonly attempt: number; readonly state: string }>`
      SELECT step_key_digest, attempt, state FROM flows_attempts WHERE run_id = ${runId}
      ORDER BY step_key_digest, attempt`
    const row = yield* (yield* RunStore.RunStore).get(runId)
    return { events: page.entries.length, attempts, status: row.status, state: row.stateJson }
  })

const success = (exit: Exit.Exit<unknown, unknown>) => Exit.isSuccess(exit) ? exit.value : Cause.pretty(exit.cause)

describe("retryFrom replays the steps before the selected one", () => {
  it("serves earlier steps from the source and runs the selected step and every step after it", () =>
    once((counts) =>
      Effect.gen(function*() {
        expect(success(yield* settle(Chain, "chain-1", { input: "a" }))).toBe("finish(prompt(load(a)#1)#1)#1")
        const before = yield* snapshotOf("chain-1")
        yield* retry(Chain, "chain-1", yield* nodeOf("chain-1", Prompt.name), "chain-1/retry")

        expect(success(yield* settle(Chain, "chain-1/retry", { input: "a" }))).toBe("finish(prompt(load(a)#1)#2)#2")
        expect(counts).toEqual({ load: 1, prompt: 2, finish: 2 })
        // The source run is exactly as it was: a retry, not a history fork.
        expect(yield* snapshotOf("chain-1")).toEqual(before)
        // The new run is a root run of the same flow and payload, keyed from the source.
        const state = yield* stateOf("chain-1/retry")
        expect(state).toMatchObject({
          flowName: Chain._tag,
          payload: { input: "a" },
          forkKeyRunIds: ["chain-1"],
          retryFrom: { source: "chain-1", step: yield* nodeOf("chain-1", Prompt.name), boundaries: [] }
        })
        expect(state["parentExecutionId"]).toBeUndefined()
        const listed = yield* (yield* RunInspection.RunInspection).list()
        expect(listed.runs.map((run) => run.runId)).toContain("chain-1/retry")
        expect(yield* retryDecision("chain-1/retry")).toMatchObject({
          decision: "retry-from",
          source: "chain-1",
          replayed: 1,
          boundaries: 0
        })
        // The replayed step reads as replayed: its node settled clean, its attempt the source's.
        const inspection = yield* (yield* RunInspection.RunInspection).inspect("chain-1/retry")
        expect(inspection.steps.find((step) => step.action === Load.name)).toMatchObject({ status: "completed" })
        expect(inspection.steps.find((step) => step.action === Load.name)!.attempts).toHaveLength(1)
      })
    ))

  it("replays nothing from the first step", () =>
    once((counts) =>
      Effect.gen(function*() {
        yield* settle(Chain, "chain-2", { input: "b" })
        yield* retry(Chain, "chain-2", yield* nodeOf("chain-2", Load.name), "chain-2/retry")
        expect(success(yield* settle(Chain, "chain-2/retry", { input: "b" }))).toBe(
          "finish(prompt(load(b)#2)#2)#2"
        )
        expect(counts).toEqual({ load: 2, prompt: 2, finish: 2 })
        expect(yield* retryDecision("chain-2/retry")).toMatchObject({ replayed: 0 })
      })
    ))

  it("joins a repeated request, and refuses another step under the same id", () =>
    once((counts) =>
      Effect.gen(function*() {
        yield* settle(Chain, "chain-3", { input: "c" })
        const step = yield* nodeOf("chain-3", Finish.name)
        yield* retry(Chain, "chain-3", step, "chain-3/retry")
        expect(success(yield* settle(Chain, "chain-3/retry", { input: "c" }))).toBe("finish(prompt(load(c)#1)#1)#2")
        yield* retry(Chain, "chain-3", step, "chain-3/retry")
        expect(success(yield* settle(Chain, "chain-3/retry", { input: "c" }))).toBe("finish(prompt(load(c)#1)#1)#2")
        expect(counts).toEqual({ load: 1, prompt: 1, finish: 2 })
        // The authoring surface turns the engine's conflict into a typed failure.
        const retryFrom = Chain.retryFrom.bind(Chain) as (
          source: string,
          options: { readonly step: string; readonly executionId: string }
        ) => Effect.Effect<string, unknown, FlowRuntime.FlowRuntime | Crypto.Crypto>
        const conflict = yield* Effect.flip(
          retryFrom("chain-3", { step: yield* nodeOf("chain-3", Prompt.name), executionId: "chain-3/retry" })
        )
        expect(conflict).toMatchObject({ _tag: "@smthrs/engine/ExecutionIdentityConflict", field: "retry" })
        // An id a plain run holds is no retry's.
        const plain = yield* Effect.flip(
          retryFrom("chain-3", { step: yield* nodeOf("chain-3", Prompt.name), executionId: "chain-3" })
        )
        expect(plain).toMatchObject({ field: "retry", expected: "no retry" })
        // A plain admission names no retry, and joins the retry's run.
        expect(success(yield* settle(Chain, "chain-3/retry", { input: "c" }))).toBe("finish(prompt(load(c)#1)#1)#2")
      })
    ))

  it("runs again a concurrent branch that was still running when the step began", () =>
    once((counts) =>
      Effect.gen(function*() {
        expect(success(yield* settle(Fan, "fan-1", {}))).toBe("join(fast()#1,slow()#1)#1")
        yield* retry(Fan, "fan-1", yield* nodeOf("fan-1", Slow.name), "fan-1/slow")
        // Prep finished before slow began: replayed. Fast finished after slow
        // began: it runs again, with slow and everything after.
        expect(success(yield* settle(Fan, "fan-1/slow", {}))).toBe("join(fast()#2,slow()#2)#2")
        expect(counts).toEqual({ prep: 1, fast: 2, slow: 2, join: 2 })
        expect((yield* stateOf("fan-1/slow"))["maxRounds"]).toBe(3)

        yield* retry(Fan, "fan-1", yield* nodeOf("fan-1", Join.name), "fan-1/join")
        // Both branches finished before the join began: both replayed.
        expect(success(yield* settle(Fan, "fan-1/join", {}))).toBe("join(fast()#1,slow()#1)#3")
        expect(counts).toEqual({ prep: 1, fast: 2, slow: 2, join: 3 })
        expect(yield* retryDecision("fan-1/join")).toMatchObject({ replayed: 3 })
      })
    ))

  it("retries a failed run from its failing step", () =>
    once((counts) =>
      Effect.gen(function*() {
        const failed = yield* settle(Breaks, "breaks-1", { input: "d" })
        expect(Exit.isFailure(failed)).toBe(true)
        yield* retry(Breaks, "breaks-1", yield* nodeOf("breaks-1", Flaky.name), "breaks-1/retry")
        expect(success(yield* settle(Breaks, "breaks-1/retry", { input: "d" }))).toBe(
          "finish(flaky(load(d)#1)#2)#1"
        )
        expect(counts).toEqual({ load: 1, flaky: 2, finish: 1 })
      })
    ))

  it("retries a retry from a step the first retry replayed", () =>
    once((counts) =>
      Effect.gen(function*() {
        yield* settle(Chain, "chain-4", { input: "e" })
        yield* retry(Chain, "chain-4", yield* nodeOf("chain-4", Finish.name), "chain-4/finish")
        expect(success(yield* settle(Chain, "chain-4/finish", { input: "e" }))).toBe("finish(prompt(load(e)#1)#1)#2")
        // The prompt was replayed in the first retry; a retry from it there
        // replays load and runs the prompt and the finish again.
        yield* retry(Chain, "chain-4/finish", yield* nodeOf("chain-4/finish", Prompt.name), "chain-4/prompt")
        expect(success(yield* settle(Chain, "chain-4/prompt", { input: "e" }))).toBe("finish(prompt(load(e)#1)#2)#3")
        expect(counts).toEqual({ load: 1, prompt: 2, finish: 3 })
        expect((yield* stateOf("chain-4/prompt"))["forkKeyRunIds"]).toEqual(["chain-4/finish", "chain-4"])
      })
    ))
})

describe("retryFrom and child boundaries", () => {
  it("carries a child that settled before the step, replayed whole, and runs the step's own child again", () =>
    once((counts) =>
      Effect.gen(function*() {
        expect(success(yield* settle(Nest, "nest-1", { input: "f" }))).toBe(
          "finish(inner(inner(load(f)#1)#1)#2)#1"
        )
        const [first, second] = yield* nodesOf("nest-1", Child._tag)
        const firstChild = yield* Interpreter.childExecutionId("nest-1", first!, Child._tag, { value: "load(f)#1" })

        // From the finish: both children carried, no inner body runs.
        yield* retry(Nest, "nest-1", yield* nodeOf("nest-1", Finish.name), "nest-1/finish")
        expect(success(yield* settle(Nest, "nest-1/finish", { input: "f" }))).toBe(
          "finish(inner(inner(load(f)#1)#1)#2)#2"
        )
        expect(counts).toEqual({ load: 1, inner: 2, finish: 2 })
        const carried = yield* Interpreter.childExecutionId("nest-1/finish", first!, Child._tag, { value: "load(f)#1" })
        expect(yield* stateOf(carried)).toMatchObject({
          parentExecutionId: "nest-1/finish",
          forkKeyRunIds: [firstChild],
          retryFrom: { source: firstChild, boundaries: [] }
        })
        expect(yield* retryDecision(carried)).toMatchObject({ source: firstChild, replayed: 1, boundaries: 0 })
        // The carried child's id is that child's, replayed whole: no retry from a step may take it.
        const childRetry = Child.retryFrom.bind(Child) as (
          source: string,
          options: { readonly step: string; readonly executionId: string }
        ) => Effect.Effect<string, unknown, FlowRuntime.FlowRuntime | Crypto.Crypto>
        const taken = yield* Effect.flip(
          childRetry(firstChild, { step: yield* nodeOf(firstChild, Inner.name), executionId: carried })
        )
        expect(taken).toMatchObject({ field: "retry", expected: `a retry of ${firstChild} from its end` })
        expect((yield* stateOf("nest-1/finish"))["retryFrom"]).toMatchObject({ boundaries: [first, second] })

        // From the second boundary: the first child carried, the second runs again.
        yield* retry(Nest, "nest-1", second!, "nest-1/second")
        expect(success(yield* settle(Nest, "nest-1/second", { input: "f" }))).toBe(
          "finish(inner(inner(load(f)#1)#1)#3)#3"
        )
        expect(counts).toEqual({ load: 1, inner: 3, finish: 3 })
        const fresh = yield* Interpreter.childExecutionId("nest-1/second", second!, Child._tag, {
          value: "inner(load(f)#1)#1"
        })
        expect((yield* stateOf(fresh))["retryFrom"]).toBeUndefined()

        // A child whose source run is gone is run afresh, not invented; the
        // second boundary's input then differs from the source's, so it runs
        // afresh too.
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM flows_attempts WHERE run_id = ${firstChild}`
        yield* sql`DELETE FROM flows_run_parents WHERE child_id = ${firstChild}`
        yield* sql`DELETE FROM flows_runs WHERE run_id = ${firstChild}`
        yield* retry(Nest, "nest-1", yield* nodeOf("nest-1", Finish.name), "nest-1/gone")
        expect(success(yield* settle(Nest, "nest-1/gone", { input: "f" }))).toBe(
          "finish(inner(inner(load(f)#1)#4)#5)#4"
        )
        expect(counts).toEqual({ load: 1, inner: 5, finish: 4 })
      })
    ))
})

describe("retryFrom refuses what it cannot retry, admitting nothing", () => {
  it("refuses a step that never ran, an unknown step, a run still going, an unknown run and another flow's run", () =>
    once(() =>
      Effect.gen(function*() {
        yield* settle(Breaks, "breaks-2", { input: "g" })
        const skipped = yield* nodeOf("breaks-2", Finish.name)
        const refusal = (source: string, step: string, flow: Flow.Any = Breaks) =>
          Effect.flip(retry(flow, source, step, `${source}/refused`))
        expect(yield* refusal("breaks-2", skipped)).toMatchObject({ code: "step_not_run", step: skipped })
        expect(yield* refusal("breaks-2", "no/such/node")).toMatchObject({ code: "step_not_found" })
        expect(yield* refusal("missing", "root")).toMatchObject({ code: "not_found", executionId: "missing" })
        expect(yield* refusal("breaks-2", skipped, Chain)).toMatchObject({ code: "other_flow" })

        const runtime = yield* engine
        yield* runtime.execute(Gated, { executionId: "gated-1", payload: {}, discard: true })
        const runs = yield* RunStore.RunStore
        while ((yield* runs.get("gated-1")).status !== "suspended") yield* Effect.sleep("5 millis")
        expect(yield* refusal("gated-1", "root", Gated)).toMatchObject({ code: "not_settled" })

        for (const source of ["breaks-2", "missing", "gated-1"]) {
          expect(Exit.isFailure(yield* Effect.exit(runs.get(`${source}/refused`)))).toBe(true)
        }
      })
    ))

  it("fails the new run with plan_changed, before any step, when the declaration changed", async () => {
    const { cleanup, filename } = await database()
    const counts: Counts = {}
    try {
      await runPromise(process(filename, { counts }, settle(Chain, "chain-5", { input: "h" })))
      const step = await runPromise(process(filename, { counts }, nodeOf("chain-5", Finish.name)))
      const exit = await runPromise(
        process(
          filename,
          { counts, flows: [ChainWithoutPrompt] },
          Effect.andThen(
            retry(ChainWithoutPrompt, "chain-5", step, "chain-5/retry"),
            settle(ChainWithoutPrompt, "chain-5/retry", { input: "h" })
          )
        )
      )
      expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : exit.value).toContain(
        "differs from the plan the retried run recorded"
      )
      expect(counts).toEqual({ load: 1, prompt: 1, finish: 1 })

      // A source whose plan record is gone cannot vouch for the plan either.
      await runPromise(process(
        filename,
        { counts },
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM flows_journal_events
          WHERE run_id = 'chain-5' AND event_type = 'flows.engine.plan-recorded'`
          yield* retry(Chain, "chain-5", step, "chain-5/unplanned")
          const unplanned = yield* settle(Chain, "chain-5/unplanned", { input: "h" })
          expect(Exit.isFailure(unplanned) ? Cause.pretty(unplanned.cause) : unplanned.value).toContain(
            "differs from the plan the retried run recorded"
          )
        })
      ))
      expect(counts).toEqual({ load: 1, prompt: 1, finish: 1 })
    } finally {
      await cleanup()
    }
  })

  it("refuses unsupported on storage that cannot copy attempts, and carries no child there", async () => {
    const { cleanup, filename } = await database()
    const counts: Counts = {}
    try {
      await runPromise(process(
        filename,
        { counts, state: withoutCopy },
        Effect.gen(function*() {
          expect(success(yield* settle(Nest, "nest-2", { input: "j" }))).toBe("finish(inner(inner(load(j)#1)#1)#2)#1")
          const refusal = yield* Effect.flip(
            retry(Nest, "nest-2", yield* nodeOf("nest-2", Finish.name), "nest-2/retry")
          )
          expect(refusal).toMatchObject({ code: "unsupported", executionId: "nest-2" })
        })
      ))
    } finally {
      await cleanup()
    }
  })
})

describe("retryFrom survives a crash of the new run", () => {
  it("resumes the new run in a later process without running a replayed step", async () => {
    const { cleanup, filename } = await database()
    const counts: Counts = {}
    try {
      await runPromise(process(filename, { counts }, settle(Chain, "chain-6", { input: "i" })))
      // The retry's prompt hangs in this process, which then exits.
      await runPromise(Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        yield* process(
          filename,
          {
            counts,
            hooks: {
              prompt: (n) => n === 2 ? Effect.andThen(Deferred.succeed(entered, undefined), Effect.never) : Effect.void
            }
          },
          Effect.gen(function*() {
            yield* retry(Chain, "chain-6", yield* nodeOf("chain-6", Prompt.name), "chain-6/retry")
            yield* Deferred.await(entered)
          })
        )
      }))
      expect(counts).toEqual({ load: 1, prompt: 2, finish: 1 })
      const resumed = await runPromise(process(filename, { counts }, settle(Chain, "chain-6/retry", { input: "i" })))
      expect(success(resumed)).toBe("finish(prompt(load(i)#1)#3)#2")
      expect(counts).toEqual({ load: 1, prompt: 3, finish: 2 })
    } finally {
      await cleanup()
    }
  })
})

describe("RetrySource.fold", () => {
  const scheduled = (seq: number, nodeId: string, kind = "ActionCall") => ({
    seq,
    eventType: "flows.engine.node-scheduled",
    payload: { nodeId, kind }
  })
  const settled = (seq: number, nodeId: string, outcome: string, extra: Record<string, unknown> = {}) => ({
    seq,
    eventType: "flows.engine.node-settled",
    payload: { nodeId, outcome, ...extra }
  })
  const started = (seq: number, stepKeyDigest: string, attempt = 1) => ({
    seq,
    eventType: "flows.engine.attempt-started",
    payload: { stepKeyDigest, attempt }
  })
  const finished = (seq: number, stepKeyDigest: string, attempt = 1) => ({
    seq,
    eventType: "flows.engine.attempt-finished",
    payload: { stepKeyDigest, attempt }
  })
  const spawned = (seq: number, childRunId: string, kind = "flows/engine-store/child-spawn") => ({
    seq,
    eventType: "flows.time-travel.effect-boundary",
    payload: { effect: { kind, output: { childRunId } } }
  })

  it("replays the attempts finished before the step's first attempt record, once each", () => {
    const records = [
      scheduled(1, "a"),
      started(2, "da"),
      finished(3, "da"),
      finished(4, "da"),
      settled(5, "a", "built", { stepKeyDigests: ["da"] }),
      scheduled(6, "b"),
      started(7, "db"),
      started(8, "dc"),
      finished(9, "dc"),
      finished(10, "db"),
      settled(11, "b", "built", { stepKeyDigests: ["db"] }),
      settled(12, "c", "built", { stepKeyDigests: ["dc"] })
    ]
    expect(RetrySource.fold(records, "b")).toEqual({
      _tag: "Seed",
      seed: { attempts: [{ stepKeyDigest: "da", attempt: 1 }], boundaries: [] }
    })
    // A step whose own first record is a finished one, as a replay re-emits it.
    expect(
      RetrySource.fold([
        finished(1, "da"),
        settled(2, "a", "clean", { stepKeyDigests: ["da"] }),
        finished(3, "db"),
        settled(4, "b", "clean", { stepKeyDigests: ["db"] })
      ], "b")
    )
      .toEqual({ _tag: "Seed", seed: { attempts: [{ stepKeyDigest: "da", attempt: 1 }], boundaries: [] } })
  })

  it("cuts a boundary step at its child's spawn, and names the boundaries settled before it", () => {
    const records = [
      scheduled(1, "b1", "FlowCall"),
      spawned(2, "child-1"),
      spawned(3, "child-1"),
      settled(4, "b1", "built", { childExecutionId: "child-1" }),
      scheduled(5, "legacy", "FlowCall"),
      settled(6, "legacy", "failed"),
      scheduled(7, "skipped", "FlowCall"),
      settled(8, "skipped", "skipped"),
      spawned(9, "other", "flows/other-effect"),
      scheduled(10, "b2", "FlowCall"),
      spawned(11, "child-2"),
      settled(12, "b2", "built", { childExecutionId: "child-2" }),
      scheduled(13, "root", "FlowCall"),
      settled(14, "root", "built")
    ]
    expect(RetrySource.fold(records, "b2")).toEqual({
      _tag: "Seed",
      seed: { attempts: [], boundaries: ["b1", "legacy"] }
    })
    expect(RetrySource.foldWhole(records)).toEqual({ attempts: [], boundaries: ["b1", "legacy", "b2"] })
  })

  it("refuses a step it has no record of, one that never settled, was skipped, or did no work of its own", () => {
    const records = [
      scheduled(1, "only-scheduled"),
      scheduled(2, "skipped"),
      settled(3, "skipped", "skipped", { stepKeyDigests: [] }),
      scheduled(4, "map", "Map"),
      settled(5, "map", "built"),
      settled(6, "unstarted", "built", { stepKeyDigests: ["never"] }),
      settled(7, "orphan-boundary", "built", { childExecutionId: "never-spawned" }),
      { seq: 8, eventType: "flows.engine.node-scheduled", payload: { kind: "ActionCall" } },
      { seq: 9, eventType: "flows.engine.node-settled", payload: "not a node" },
      { seq: 10, eventType: "flows.engine.attempt-started", payload: {} },
      { seq: 11, eventType: "flows.engine.attempt-finished", payload: { attempt: 1 } }
    ]
    expect(RetrySource.fold(records, "nothing")).toEqual({ _tag: "Refused", code: "step_not_found" })
    for (const step of ["only-scheduled", "skipped", "map", "unstarted", "orphan-boundary"]) {
      expect(RetrySource.fold(records, step)).toEqual({ _tag: "Refused", code: "step_not_run" })
    }
    expect(RetrySource.foldWhole(records)).toEqual({ attempts: [], boundaries: ["orphan-boundary"] })
  })
})

describe("RetrySource.resolve", () => {
  it("reads a journal longer than one page", () =>
    once(() =>
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const pages = 1_000
        for (let index = 0; index < pages + 5; index++) {
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make("paged"),
              sourceId: JournalEvent.SourceId.make("retry-from-test"),
              eventType: "flows.engine.attempt-finished",
              payload: { stepKeyDigest: `d${index}`, attempt: 1 }
            })
          )
        }
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make("paged"),
            sourceId: JournalEvent.SourceId.make("retry-from-test"),
            eventType: "flows.engine.node-settled",
            payload: { nodeId: "last", outcome: "built", stepKeyDigests: ["d1004"] }
          })
        )
        const resolved = yield* RetrySource.resolve(journal, "paged", "last")
        expect(resolved._tag === "Seed" && resolved.seed.attempts.length).toBe(pages + 4)
        expect((yield* RetrySource.resolveWhole(journal, "paged")).attempts).toHaveLength(pages + 5)
      })
    ))
})
