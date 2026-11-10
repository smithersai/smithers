/**
 * A run parked under one build resumes under the next.
 *
 * The plan record names where each node was declared, and a rebuild moves
 * those sites without changing the flow: a bundler that adds a line above a
 * flow shifts every declaration below it. Those sites are provenance, never
 * identity, so a resume compares the structural plan and lets the rebuilt
 * sites go. A real structural change is still refused with `plan_changed`.
 *
 * A production bundle is minified, and a minifier renames a callback's
 * bindings whenever unrelated code in the bundle changes. A callback is
 * identified by its source with those names erased, so a rebuilt minified
 * bundle resumes too, while a real edit to a callback is refused.
 *
 * Every case parks a run on a durable deferred, reopens the store with a new
 * engine, and resumes it. The storage matrix runs the file once on SQLite and
 * once on PostgreSQL.
 */
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node, type Planned } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import * as Minified from "./fixtures/MinifiedBuild.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
import * as Rebuilt from "./fixtures/RebuiltAnswerFlow.ts"
import { runPromise } from "./Sha256.ts"

const gate = DurableDeferred.make("plan-sites-gate", { success: Schema.Number })

// The first build. `fixtures/RebuiltAnswerFlow.ts` declares the same flow
// character for character, at other lines of another file.

const Ask = Action.make("plan-sites/ask", {
  payload: {},
  success: Schema.Number,
  tier: "irreversible",
  idempotencyKey: "plan-sites-ask"
})

const Double = Action.make("plan-sites/double", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  idempotencyKey: "plan-sites-double-v1",
  implementationVersion: "1"
})

const then = Node.bindPlanned(Node.capture({}, (value: Planned.Planned<number>) => Double.call({ value })))
const addOne = Node.map(Node.capture({}, (value: number) => value + 1))

const Answer = Flow.make("plan-sites/answer", {
  payload: {},
  success: Schema.Number,
  body: () => Ask.call({}).pipe(then, addOne)
})

/** A later build that removed the doubling step: a real change to the plan. */
const Restructured = Flow.make("plan-sites/answer", {
  payload: {},
  success: Schema.Number,
  body: () => Ask.call({}).pipe(addOne)
})

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

const executionId = "answer-run"

/** Every plan row the journal holds for the run, oldest first. */
const planRows = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const page = yield* journal.entries({ runId: JournalEvent.RunId.make(executionId), limit: 1000 })
  return page.entries
    .filter((entry) =>
      entry.eventType === "flows.engine.plan-recorded" || entry.eventType === "flows.engine.subgraph-appended"
    )
    .map((entry) => ({ eventType: entry.eventType, payload: entry.payload, meta: entry.meta }))
})

const sites = (flow: Flow.Any) => Graph.nodes(Graph.build(flow, {})).map((node) => node.declaredAt)

/** A bundle's sites: one file, lines that have nothing to do with this one's. */
const bundleSites = (event: JournalEvent.Input): JournalEvent.Input => {
  const payload = structuredClone(event.payload) as { graph: { nodes: Array<Record<string, unknown>> } }
  payload.graph.nodes.forEach((node, index) => {
    node["declaredAt"] = { path: "DevChatApi.js", line: 49 + index }
  })
  return { ...event, payload }
}

/** A build of the answer flow: the flow and the actions it calls. */
interface Build {
  readonly Answer: typeof Answer
  readonly Ask: typeof Ask
  readonly Double: typeof Double
}

/** A minified build, typed as the test file's: the same declarations under other tags. */
const minify = async (options?: Parameters<typeof Minified.build>[0]): Promise<Build> =>
  (await Minified.build(options)) as unknown as Build

const testFile: Build = { Answer, Ask, Double }

/**
 * The minified builds: the fixture alone, the fixture beside unrelated code,
 * and that second build with a real edit to the mapper.
 */
let minified: { readonly alone: Build; readonly beside: Build; readonly edited: Build }

beforeAll(async () => {
  minified = {
    alone: await minify(),
    beside: await minify({ beside: Minified.unrelated }),
    edited: await minify({
      beside: Minified.unrelated,
      edit: (source) => source.replace("value + this.step", "value - this.step")
    })
  }
})

interface Scenario {
  readonly first: () => Build
  readonly resumed: () => Build
  /** The first build's plan record carries a bundle's sites. */
  readonly bundled?: boolean
  /** The resuming host cannot place its sources under a root. */
  readonly unrooted?: boolean
  /** How the resume ends: it completes, or the rebuilt plan is refused. */
  readonly outcome: "completed" | "plan_changed"
}

const scenarios: Record<string, Scenario> = {
  relocated: { first: () => testFile, resumed: () => Rebuilt, outcome: "completed" },
  unrooted: { first: () => testFile, resumed: () => Rebuilt, unrooted: true, outcome: "completed" },
  "earlier-bundle": { first: () => testFile, resumed: () => testFile, bundled: true, outcome: "completed" },
  restructured: {
    first: () => testFile,
    resumed: () => ({ ...testFile, Answer: Restructured }),
    outcome: "plan_changed"
  },
  minified: { first: () => minified.alone, resumed: () => minified.beside, outcome: "completed" },
  "minified-edited": { first: () => minified.alone, resumed: () => minified.edited, outcome: "plan_changed" }
}

it.each(Object.keys(scenarios))(
  "resumes a parked run whose plan was rebuilt: %s",
  async (name) => {
    const scenario = scenarios[name]!
    const root = await mkdtemp(join(tmpdir(), "smithers-plan-sites-"))
    const filename = PersistentDatabase.filename(join(root, "state.sqlite"))
    const dispatched = { ask: 0, double: 0 }

    const drive = (first: boolean) =>
      Effect.scoped(Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const recording: Journal.Service = first && scenario.bundled === true
          ? {
            ...journal,
            emitDurable: (event, owner) =>
              journal.emitDurable(event.eventType === "flows.engine.plan-recorded" ? bundleSites(event) : event, owner)
          }
          : journal
        const engine = yield* EngineStore.make({
          owner: { hostId: "plan-sites" },
          journalSource: "plan-sites",
          isAlive: () => Effect.succeed(false),
          // A host that cannot place its sources under a root records no sites.
          declarationRoot: !first && scenario.unrooted === true ? "/no/such/root" : process.cwd()
        }).pipe(Effect.provideService(Journal.Journal, recording))
        const build = first ? scenario.first() : scenario.resumed()
        const flow = build.Answer
        const layer = Layer.mergeAll(
          build.Ask.toLayer(() =>
            Effect.sync(() => {
              dispatched.ask++
            }).pipe(Effect.andThen(DurableDeferred.await(gate)))
          ),
          build.Double.toLayer(({ value }) =>
            Effect.sync(() => {
              dispatched.double++
              return value * 2
            }), { implementationVersion: "1" }),
          Interpreter.layer(flow)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine))
        )
        return yield* Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          if (first) {
            yield* flow.execute({}, { executionId, discard: true })
            yield* TestDatabase.until(Effect.map(runs.get(executionId), (row) => row.status === "suspended"))
            return { status: (yield* runs.get(executionId)).status, plan: yield* planRows, result: undefined }
          }
          yield* engine.deferredDone(gate, {
            flowName: flow._tag,
            executionId,
            deferredName: gate.name,
            exit: Exit.succeed(4)
          })
          yield* TestDatabase.until(
            Effect.map(runs.get(executionId), (row) => row.status !== "suspended" && row.status !== "running")
          )
          return {
            status: (yield* runs.get(executionId)).status,
            plan: yield* planRows,
            result: yield* engine.poll(flow, executionId)
          }
        }).pipe(Effect.provide(layer))
      })).pipe(
        Effect.provide(jj),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(TestStores.layerAt(filename)),
        Effect.orDie
      )

    try {
      const parked = await runPromise(drive(true))
      expect(parked.status).toBe("suspended")
      expect(parked.plan).toHaveLength(1)
      if (scenario.first() === testFile) {
        // The parked record carries its sites inside the content a resume compares.
        const recorded = parked.plan[0]!.payload as { graph: { nodes: Array<{ declaredAt?: unknown }> } }
        expect(recorded.graph.nodes.some((node) => node.declaredAt !== undefined)).toBe(true)
      }
      if (name === "relocated") {
        // The rebuilt sites really are elsewhere: another file and other lines.
        const before = sites(Answer).filter((site) => site !== undefined)
        const after = sites(Rebuilt.Answer).filter((site) => site !== undefined)
        expect(after).toHaveLength(before.length)
        after.forEach((site, index) => {
          expect(site!.path).not.toBe(before[index]!.path)
          expect(site!.line).not.toBe(before[index]!.line)
        })
      }
      if (name === "minified") {
        // The rebuilt callbacks really read differently: the minifier renamed them.
        expect(String(minified.beside.Answer.body)).not.toBe(String(minified.alone.Answer.body))
      }
      const asked = dispatched.ask

      const resumed = await runPromise(drive(false))
      // The first build's record stands, unrewritten, whatever happened next.
      expect(resumed.plan).toEqual(parked.plan)
      if (scenario.outcome === "plan_changed") {
        expect(resumed.status).toBe("failed")
        expect(dispatched).toEqual({ ask: asked, double: 0 })
        // What a caller polling the run sees: a settled failure that says why,
        // decoded from the stored row as the interpreter's own typed refusal.
        const polled = Option.getOrThrow(resumed.result!)
        if (polled._tag !== "Complete" || Exit.isSuccess(polled.exit)) throw new Error("the run did not fail")
        expect(Interpreter.refusalCode(polled.exit.cause)).toEqual(Option.some("plan_changed"))
        expect(Cause.squash(polled.exit.cause)).toBeInstanceOf(Interpreter.InterpreterError)
        expect(Cause.squash(polled.exit.cause)).toMatchObject({
          code: "plan_changed",
          flow: scenario.resumed().Answer._tag
        })
        return
      }
      expect(resumed.status).toBe("completed")
      expect(dispatched).toEqual({ ask: asked + 1, double: 1 })
      expect(resumed.result).toMatchObject({
        _tag: "Some",
        value: { _tag: "Complete", exit: { _tag: "Success", value: 9 } }
      })
    } finally {
      await PersistentDatabase.remove(filename)
      await rm(root, { recursive: true, force: true })
    }
  }
)
