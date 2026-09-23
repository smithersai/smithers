/**
 * What a `ctx.done()` frame costs, and how much of it is workspace observation.
 *
 * The TUI showed a one-line `ctx.done("…")` answer 8 s after the model
 * returned it (session log 2026-09-23): the model took 0.3–0.6 s, and each
 * frame measured `~/smithers` twice at 3–5 s a measurement. Three groups, so
 * a regression names its layer:
 *
 * - `turn`: one `Agent.run` whose scripted model answers `ctx.done("ok")`,
 *   with no observer and with `NodeControl.layerObserver` over each fixture.
 * - `observe`: one measurement over each fixture, on the portable Effect
 *   `FileSystem` host and on the Node host `NodeControl` composes.
 * - `entry`: the per-entry host calls each host makes.
 *
 * Fixtures: `small` is 2,000 files in 100 directories; `capped` is 60,000,
 * past `TreeFingerprint.maxPaths`, which is the shape of this repository.
 *
 * Run: `pnpm --filter @smthrs/cli bench`.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Agent from "@smthrs/agent/Agent"
import * as Budget from "@smthrs/agent/Budget"
import type * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import { layer as scriptedCompletionJudge } from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Deferred, Effect, FileSystem, Layer, Metric, Option, Schema, Scope, Stream } from "effect"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, test } from "vitest"
import { host as nodeHost } from "../../src/internal/NodeWorkspaceObservation.ts"
import * as NodeControl from "../../src/NodeControl.ts"

const Safety = { layer: Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified()) }

const tree = (files: number, perDirectory: number): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-observation-bench-")))
  for (let index = 0; index < files; index++) {
    const directory = join(root, `d${String(Math.floor(index / perDirectory)).padStart(4, "0")}`)
    if (index % perDirectory === 0) mkdirSync(directory)
    writeFileSync(join(directory, `f${String(index).padStart(6, "0")}.ts`), "export {}\n")
  }
  return root
}

const small = tree(2_000, 20)
const capped = tree(60_000, 200)
const fixtures = { small, capped } as const
const regularFile = join(small, "d0000", "f000000.ts")

afterAll(() => {
  for (const root of Object.values(fixtures)) rmSync(root, { recursive: true, force: true })
})

const hostFs = Effect.runSync(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer))

/** Slow cases run a fixed few times rather than for a time budget. */
const few = { time: 0, iterations: 3, warmup: true, warmupIterations: 1, warmupTime: 0 }

/** A capped measurement takes seconds, and each case runs it four times. */
const slow = { timeout: 600_000 }

const prepared: Route.PreparedRequest = {
  routeId: "route-bench",
  protocolId: "bench-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}
const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** A model that answers every request with one `ctx.done("ok")` cell. */
const doneModel = Model.make({
  stream: () =>
    Stream.fromIterable([
      ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
      ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\nctx.done(\"ok\")\n```" }),
      ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
      ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
})

const turnFlow = Flow.make("agent/bench/turn", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

let executions = 0

/** One whole `Agent.run` that resolves on its first frame, the way the TUI drives it. */
const turn = (observer: Layer.Layer<never> | Layer.Layer<WorkspaceObservation.Observer>) =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<void>()
    let resolved = false
    const body = Effect.gen(function*() {
      const agent = yield* Agent.Agent
      yield* agent.run({
        session: "bench",
        seat: Seat.make({ id: "anthropic:bench", modelId: "bench", model: doneModel, route, contextWindowTokens: 0 }),
        prompt: "answer",
        system: [],
        registry: Registry.makeNoop(),
        maxFrames: 1
      }).pipe(
        Stream.runForEach((event) => Effect.sync(() => (resolved ||= event._tag === "resolved"))),
        Effect.provide(Layer.merge(Agent.layerDefaults, scriptedCompletionJudge))
      )
    }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))
    yield* engine.register(turnFlow, () => Effect.onExit(body, () => Deferred.succeed(settled, undefined))).pipe(
      Scope.provide(scope)
    )
    yield* engine.execute(turnFlow, { executionId: `bench-${++executions}`, payload: {}, discard: true })
    yield* Deferred.await(settled)
    if (!resolved) throw new Error("the bench turn did not resolve")
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer, Safety.layer, observer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.scoped,
    Effect.runPromise
  )

const observerOver = (root: string) => NodeControl.layerObserver(root)

describe("workspace observation", () => {
  test("turn: ctx.done() through Agent.run", slow, async ({ bench }) => {
    await bench.compare(
      bench("no observer", () => turn(Layer.empty)),
      bench("observer, small (2,000 files)", () => turn(observerOver(small))),
      bench("observer, capped (60,000 files)", () => turn(observerOver(capped))),
      few
    )
  })

  test("observe: one measurement", slow, async ({ bench }) => {
    await bench.compare(
      bench(
        "FileSystem host, small (2,000 files)",
        () => Effect.runPromise(Effect.asVoid(WorkspaceObservation.observe(hostFs, small)))
      ),
      bench(
        "FileSystem host, capped (60,000 files)",
        () => Effect.runPromise(Effect.asVoid(WorkspaceObservation.observe(hostFs, capped)))
      ),
      bench(
        "Node host, small (2,000 files)",
        () => Effect.runPromise(Effect.asVoid(WorkspaceObservation.observeHost(nodeHost, small)))
      ),
      bench(
        "Node host, capped (60,000 files)",
        () => Effect.runPromise(Effect.asVoid(WorkspaceObservation.observeHost(nodeHost, capped)))
      ),
      few
    )
  })

  test("entry: one host call", async ({ bench }) => {
    await bench.compare(
      bench("Effect readLink on a regular file (fails)", () =>
        Effect.runPromise(
          Effect.asVoid(hostFs.readLink(regularFile).pipe(Effect.asSome, Effect.orElseSucceed(() => Option.none())))
        )),
      bench("Effect stat", () => Effect.runPromise(Effect.asVoid(hostFs.stat(regularFile)))),
      bench("node lstat, bigint (Node host, per file)", () => lstat(regularFile, { bigint: true }).then(() => {})),
      bench("node lstatSync (floor)", () => {
        lstatSync(regularFile)
      }),
      bench("node readdirSync withFileTypes (20 entries)", () => {
        readdirSync(join(small, "d0000"), { withFileTypes: true })
      })
    )
  })
})
