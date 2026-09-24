/**
 * The one thing the production composition withholds from its own step cache.
 *
 * `@smthrs/engine` `FlowEngine/ActionKey.actionKey` folds the execution id
 * into a sealed keyed dispatch's persisted key whenever
 * `Action.CurrentCacheEnvironment` is absent, so the row a run publishes is
 * addressed under an identity no later run can spell. Everything else a
 * cross-run hit needs is already wired here: `CacheStore` in `Runtime.storage`,
 * the filesystem `StepBoundary`, and the workspace sandbox whose whole-tree
 * diff is what attests the write and read verification `CacheAdmission`
 * demands. The environment is the missing declaration, and it is
 * complete-or-absent by contract, so a host declares it or the engine keeps
 * every key run-local.
 *
 * Both runs below go through `NodeRuntime` with the production boundary and
 * the real filesystem sandbox, over one SQLite file, with the same input.
 * The body's own counter decides, not a label.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Action, EngineStore as EngineStorePackage, Flow, Interpreter, Kernel } from "../src/index.ts"
import * as NodeRuntime from "../src/NodeRuntime.ts"

const { StepBoundary, WorkspaceSandbox } = EngineStorePackage
const { Jj } = Kernel

const directory = mkdtempSync(join(tmpdir(), "flows-cache-environment-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

/** A Jujutsu service that records nothing: the step below is sealed. */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "cache-environment" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const host = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, stubJj)

/**
 * Cache-eligible by the engine's own rule and by no other: the `sealed` tier
 * `Action.make` defaults to, a `hard` `fileBoundary` with a resolved read set,
 * a declared idempotency key, and the implementation version the interpreter
 * requires of a sealed keyed action. This step touches no file, which is what
 * the empty sets say.
 */
const Summarize = Action.make("cache-environment/summarize", {
  payload: { label: Schema.String },
  success: Schema.String,
  implementationVersion: "1",
  fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" },
  idempotencyKey: ({ label }: { readonly label: string }) => `cache-environment/summarize:${label}`
})

const Summary = Flow.make("cache-environment/flow", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: ({ label }) => Summarize.call({ label })
})

/** How many times the body was entered, which is the only evidence here. */
const dispatches = { summarize: 0 }

const registerFlows = Interpreter.layer(Summary).pipe(
  Layer.provideMerge(
    Summarize.toLayer(({ label }: { readonly label: string }) =>
      Effect.sync(() => {
        dispatches.summarize += 1
        return `summary:${label}`
      }), { implementationVersion: "1" })
  ),
  Layer.provideMerge(Action.layerImplementations)
)

/** Two runs of one flow over one database, returning what each produced. */
const twice = (name: string, cacheEnvironment?: Action.CacheEnvironment) =>
  Effect.scoped(Effect.gen(function*() {
    const context = yield* NodeRuntime.make(
      {
        filename: join(directory, name, "engine.sqlite"),
        workspaceRoot: join(directory, name),
        owner: { hostId: name },
        isAlive: () => Effect.succeed(false),
        ...(cacheEnvironment === undefined ? {} : { cacheEnvironment })
      },
      StepBoundary.layer,
      WorkspaceSandbox.layerFileSystem(),
      registerFlows
    )
    const first = yield* Summary.execute({ label: "report" }, { executionId: `${name}-first` }).pipe(
      Effect.provide(context)
    )
    const second = yield* Summary.execute({ label: "report" }, { executionId: `${name}-second` }).pipe(
      Effect.provide(context)
    )
    return { first, second }
  })).pipe(Effect.provide(host))

it("runs a cacheable step again on every run while the host declares no cache environment", async () => {
  dispatches.summarize = 0
  const settled = await Effect.runPromise(twice("absent"))

  expect(settled).toEqual({ first: "summary:report", second: "summary:report" })
  // The published row is real; its address is not reachable from the second
  // run, so the body ran twice for one answer.
  expect(dispatches.summarize).toBe(2)
}, 120_000)

it("serves a cacheable step from the step cache on the second run once the host declares one", async () => {
  dispatches.summarize = 0
  const settled = await Effect.runPromise(
    twice("declared", { layers: ["flows/cache-environment-test/v1"], capabilities: {} })
  )

  expect(settled).toEqual({ first: "summary:report", second: "summary:report" })
  expect(dispatches.summarize).toBe(1)
}, 120_000)

it("serves a cacheable step from the step cache when a layerHost host declares one", async () => {
  dispatches.summarize = 0
  const root = join(directory, "host")
  const settled = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(NodeRuntime.layerHost(
      {
        filename: join(root, "engine.sqlite"),
        workspaceRoot: root,
        owner: { hostId: "host" },
        signals: [],
        cacheEnvironment: { layers: ["flows/cache-environment-test/v1"], capabilities: {} }
      },
      registerFlows
    ))
    const first = yield* Summary.execute({ label: "report" }, { executionId: "host-first" }).pipe(
      Effect.provide(context)
    )
    const second = yield* Summary.execute({ label: "report" }, { executionId: "host-second" }).pipe(
      Effect.provide(context)
    )
    return { first, second }
  })))

  expect(settled).toEqual({ first: "summary:report", second: "summary:report" })
  expect(dispatches.summarize).toBe(1)
}, 120_000)
