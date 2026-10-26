import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { expect, it } from "@effect/vitest"
import { ArtifactStore } from "@smthrs/artifacts"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { FlowEngine } from "@smthrs/engine"
import { EngineStore, OwnerIdentity, StepBoundary, WorkspaceSandbox } from "@smthrs/engine-store"
import { Action, Flow, FlowRuntime, Interpreter, RunMetrics } from "@smthrs/flow"
import * as Jj from "@smthrs/jj/Jj"
import { Workspace } from "@smthrs/kernel"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { Migrations as RunMigrations, RunStore } from "@smthrs/run-store"
import { Context, Effect, Exit, Layer, Logger, Metric, Option, References, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Runtime from "../src/Runtime.ts"

const options: Runtime.Options = {
  owner: { hostId: "injected-runtime" },
  isAlive: () => Effect.succeed(false)
}

/** What a native host injects beside the database: its identity, a workspace, and artifacts on disk. */
const nativeStorage = (root: string) =>
  Layer.mergeAll(
    OwnerIdentity.layer,
    Workspace.layer(root),
    ArtifactStore.layerFileSystem({ directory: join(root, "objects") })
  )

it("reports invalid JavaScript configuration before constructing injected services", () => {
  const invalid = [
    [{ owner: undefined }, "owner.hostId"],
    [{ isAlive: undefined }, "isAlive"],
    [{ canExecute: "yes" }, "canExecute"],
    [{ canActivate: "yes" }, "canActivate"],
    [{ requestResume: "yes" }, "requestResume"],
    // Cache key material, so an incomplete declaration is refused where it is
    // written rather than folded into every sealed key this host derives.
    [{ cacheEnvironment: { layers: [""], capabilities: {} } }, "cacheEnvironment"],
    [{ cacheEnvironment: { layers: [] } }, "cacheEnvironment"],
    // A ref a reader could not resolve is not a revision (D-068).
    [{ sourceRevision: "" }, "sourceRevision"],
    [{ placement: "" }, "placement"],
    [{ placement: 1 }, "placement"],
    [{ privilegedJj: "jj" }, "privilegedJj"],
    // A host-driven sweep names the one execution it drives.
    [{ sweep: "sometimes" }, "sweep"],
    [{ sweep: { host: "" } }, "sweep"],
    [{ sweep: { host: "hello-1", flow: "" } }, "sweep"],
    // A bound on resumed runs is a count of turns, at least one.
    [{ resumeConcurrency: 0 }, "resumeConcurrency"],
    [{ resumeConcurrency: 1.5 }, "resumeConcurrency"],
    [{ resumeConcurrency: "2" }, "resumeConcurrency"]
  ] as const
  for (const [patch, field] of invalid) {
    const parameters = [
      { ...options, ...patch } as unknown as Runtime.Options,
      StepBoundary.layer,
      WorkspaceSandbox.layerFileSystem(),
      Layer.empty
    ] as const
    for (const construct of [() => Runtime.make(...parameters), () => Runtime.layer(...parameters)]) {
      expect(construct).toThrow(expect.objectContaining({ code: "invalid_runtime_configuration", field }))
    }
  }
})

it("records each runtime construction phase without payload or database details", async () => {
  const phases: Array<string> = []
  let registrationParent = ""
  const logger = Logger.make((entry) => {
    if (JSON.stringify(entry.message).includes("flows.runtime.phase")) {
      const record = Logger.formatStructured.log(entry)
      phases.push(String(record.annotations.phase))
      expect(record.annotations.durationMs).toEqual(expect.any(Number))
    }
  })
  const host = Layer.mergeAll(
    NodeDatabase.layer({ filename: ":memory:" }),
    NodeCrypto.layer,
    Jj.layerNoop({}),
    OwnerIdentity.layerWithoutPid.pipe(Layer.provide(NodeCrypto.layer))
  )
  const registration = Layer.effectDiscard(Effect.map(Effect.currentSpan, (span) => {
    registrationParent = span.name
  }))
  const runtime = Runtime.layer(options, StepBoundary.layerUnsupported, WorkspaceSandbox.layerUnsupported, registration)
    .pipe(Layer.provide(host))
  await Effect.runPromise(
    Effect.scoped(Layer.build(runtime)).pipe(
      Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
      Effect.provideService(RunMetrics.LineLevel, "Info"),
      Effect.withSpan("host")
    )
  )
  expect(phases).toEqual(["migrations", "stores", "engine", "registry", "registration"])
  // Registration can capture this context for the lifetime of the runtime.
  // A short-lived construction span must not become its parent.
  expect(registrationParent).toBe("host")
})

it("uses the caller's SQL instance for every migrated store without opening a second database", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-injected-runtime-"))
  try {
    await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        for (const registry of [undefined, Layer.empty]) {
          yield* Effect.scoped(Effect.gen(function*() {
            const parameters = [options, StepBoundary.layer, WorkspaceSandbox.layerFileSystem(), Layer.empty] as const
            const context = yield* registry === undefined
              ? Runtime.make(...parameters)
              : Runtime.make(...parameters, registry)
            const writer = Context.get(context, DurableWriter.DurableWriter)
            expect(yield* sql`SELECT name FROM sqlite_master WHERE name = 'flows_runs'`)
              .toEqual([{ name: "flows_runs" }])
            yield* sql`CREATE TABLE IF NOT EXISTS injected_probe (value INTEGER)`
            const rolledBack = yield* Effect.exit(writer.write(
              sql`INSERT INTO injected_probe VALUES (1)`.pipe(Effect.andThen(Effect.fail("reject")))
            ))
            expect(Exit.isFailure(rolledBack)).toBe(true)
            expect(yield* sql`SELECT * FROM injected_probe`).toEqual([])
          }))
        }
      }).pipe(
        Effect.provide(
          nativeStorage(root).pipe(Layer.provideMerge(Layer.mergeAll(
            NodeDatabase.layer({ filename: ":memory:" }),
            AtomicFileSystem.layer,
            NodeCrypto.layer,
            NodePath.layer,
            Jj.layerNoop({})
          )))
        ),
        Effect.scoped
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("isolates store instances from an enclosing control database in the same layer memo map", async () => {
  const control = RunStore.layer.pipe(Layer.provideMerge(
    RunMigrations.layer.pipe(Layer.provideMerge(
      DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: ":memory:" })))
    ))
  ))
  const engine = Runtime.storage.pipe(Layer.provide(NodeDatabase.layer({ filename: ":memory:" })))
  await Effect.runPromise(
    Effect.gen(function*() {
      const controlStore = yield* RunStore.RunStore
      yield* controlStore.create("control-only", "{}")
      const engineContext = yield* Layer.build(engine)
      const engineStore = Context.get(engineContext, RunStore.RunStore)
      expect((yield* Effect.flip(engineStore.get("control-only"))).code).toBe("not_found_row")
      yield* engineStore.create("engine-only", "{}")
      expect((yield* Effect.flip(controlStore.get("engine-only"))).code).toBe("not_found_row")
    }).pipe(Effect.provide(control), Effect.scoped)
  )
})

it("takes the engine's step snapshots on the privileged Jj and leaves the ambient Jj to actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "flows-runtime-privileged-jj-"))
  const recording = (calls: Array<string>) =>
    Jj.makeNoop({
      snapshot: (message) =>
        Effect.sync(() => calls.push(message ?? "")).pipe(
          Effect.as({ commitId: "c0ffee", changeId: "kkkk", operationId: "0abc" } as Jj.Snapshot)
        )
    })
  const snapshotWith = (privileged: Array<string> | undefined, ambient: Array<string>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const context = yield* Runtime.make(
          {
            ...options,
            ...(privileged === undefined ? {} : { privilegedJj: Layer.succeed(Jj.Jj, recording(privileged)) })
          },
          StepBoundary.layer,
          WorkspaceSandbox.layerFileSystem(),
          Layer.empty
        )
        const boundary = Context.get(context, FlowEngine.SnapshotBoundary)
        // The boundary reads only the step key and attempt; no flow is dispatched.
        yield* boundary.snapshot({
          flow: undefined as never,
          executionId: "execution",
          key: "step/one",
          attempt: 1,
          metadata: undefined
        })
      }).pipe(
        Effect.provide(
          nativeStorage(root).pipe(Layer.provideMerge(Layer.mergeAll(
            NodeDatabase.layer({ filename: ":memory:" }),
            AtomicFileSystem.layer,
            NodeCrypto.layer,
            NodePath.layer,
            Layer.succeed(Jj.Jj, recording(ambient))
          )))
        ),
        Effect.scoped
      )
    )
  try {
    const privileged: Array<string> = []
    const ambient: Array<string> = []
    await snapshotWith(privileged, ambient)
    expect(privileged).toEqual(["smithers action step/one attempt 1"])
    expect(ambient).toEqual([])
    // Without a privileged repository the engine snapshots on the ambient one.
    const shared: Array<string> = []
    await snapshotWith(undefined, shared)
    expect(shared).toEqual(["smithers action step/one attempt 1"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const Greet = Action.make("Runtime/Greet", { payload: { name: Schema.String }, success: Schema.String })
const Hello = Flow.make("Runtime/Hello", {
  payload: { name: Schema.String },
  success: Schema.String,
  body: ({ name }) => Greet.call({ name })
})

it("runs a flow on a host with no filesystem, from injected services alone", async () => {
  const fenced: Array<number> = []
  // Everything a Worker host can give: a SQL client, crypto, a refusing Jj,
  // an identity without a process id, and boundaries that refuse files. No
  // FileSystem, Path, Workspace or ArtifactStore exists anywhere below.
  const host = OwnerIdentity.layerWithoutPid.pipe(Layer.provideMerge(Layer.mergeAll(
    NodeDatabase.layer({ filename: ":memory:" }),
    NodeCrypto.layer,
    Jj.layerNoop({})
  )))
  const runtime = Runtime.layer(
    { ...options, placement: "cloudflare", sweep: { host: "hello-1", flow: Hello._tag } },
    StepBoundary.layerUnsupported,
    WorkspaceSandbox.layerUnsupported,
    Interpreter.layer(Hello).pipe(
      Layer.provideMerge(Greet.toLayer(({ name }) =>
        Effect.map(Action.CurrentFence, (fence) => {
          fenced.push(fence?.attempt ?? 0)
          return `hello ${name}`
        })
      )),
      Layer.provideMerge(Action.layerImplementations)
    )
  ).pipe(Layer.provide(host))
  const outcome = await Effect.runPromise(
    Effect.gen(function*() {
      const flows = yield* FlowRuntime.FlowRuntime
      // The host's own drive, once, as a Durable Object alarm runs it.
      const driven = yield* EngineStore.drive(Hello, { executionId: "hello-1", payload: { name: "worker" } })
      const greeting = yield* flows.execute(Hello, { executionId: "hello-1", payload: { name: "worker" } })
      return { driven, greeting, wake: yield* EngineStore.nextWake("hello-1"), metrics: yield* Metric.snapshot }
    }).pipe(Effect.provide(runtime), Effect.provideService(Metric.MetricRegistry, new Map()), Effect.scoped)
  )
  expect(outcome.metrics.filter(({ id }) => id === "flows_runs_started")).toMatchObject([{
    attributes: { flow: Hello._tag, placement: "cloudflare" },
    state: { count: 1 }
  }])
  expect(outcome.driven).toEqual({ _tag: "Settled", status: "completed" })
  expect(outcome.greeting).toBe("hello worker")
  // Settled, so its host has nothing left to wake.
  expect(outcome.wake).toEqual(Option.none())
  // The step ran under the engine's fence, as its first attempt.
  expect(fenced).toEqual([1])
})

// A browser engine registers hundreds of flows per start. At Info per registration, every cold page load wrote one
// `engine-store.registration.recovered` line per registration (446 in production on 2026-10-25).
it("logs registration recovery once at Info when registration finishes, and each registration at Debug", async () => {
  const Bye = Flow.make("Runtime/Bye", {
    payload: { name: Schema.String },
    success: Schema.String,
    body: ({ name }) => Greet.call({ name })
  })
  const recovery = async (runtimeOptions: Runtime.Options) => {
    const lines: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const logger = Logger.make((entry) => {
      lines.push(Logger.formatStructured.log(entry))
    })
    const runtime = Runtime.layer(
      runtimeOptions,
      StepBoundary.layerUnsupported,
      WorkspaceSandbox.layerUnsupported,
      Layer.mergeAll(Interpreter.layer(Hello), Interpreter.layer(Bye)).pipe(
        Layer.provideMerge(Greet.toLayer(({ name }) => Effect.succeed(`hello ${name}`))),
        Layer.provideMerge(Action.layerImplementations)
      )
    ).pipe(Layer.provide(OwnerIdentity.layerWithoutPid.pipe(Layer.provideMerge(Layer.mergeAll(
      NodeDatabase.layer({ filename: ":memory:" }),
      NodeCrypto.layer,
      Jj.layerNoop({})
    )))))
    await Effect.runPromise(
      Effect.scoped(Layer.build(runtime)).pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )
    const summary = lines.filter((line) => line.message === "engine-store.registration.recovered")
    const detail = lines.filter((line) => line.message === "engine-store.registration.flow.recovered")
    expect(summary).toHaveLength(1)
    expect(summary[0]!.level).toBe("INFO")
    expect(summary[0]!.annotations).toEqual({ registrations: detail.length, durationMs: expect.any(Number) })
    expect(detail.every((line) => line.level === "DEBUG")).toBe(true)
    // The summary follows every registration.
    expect(lines.indexOf(summary[0]!)).toBeGreaterThan(lines.indexOf(detail.at(-1)!))
    return detail.map((line) => line.annotations["smithers.flow"])
  }
  const all = await recovery(options)
  expect(all).toEqual(expect.arrayContaining([Hello._tag, Bye._tag]))
  // Each flow and each system flow its interpreter registers.
  expect(all.length).toBeGreaterThan(2)
  // A hosted store recovers only its execution's flow, and counts that one.
  expect(await recovery({ ...options, sweep: { host: "hello-1", flow: Hello._tag } })).toEqual([Hello._tag])
})

it("provides a declared cache environment under the engine, where an action reads it", async () => {
  const environment: Action.CacheEnvironment = { layers: ["flows/runtime-test/v1"], capabilities: {} }
  const seen: Array<Action.CacheEnvironment | undefined> = []
  const run = (cacheEnvironment: Action.CacheEnvironment | undefined, executionId: string) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const flows = yield* FlowRuntime.FlowRuntime
        return yield* flows.execute(Hello, { executionId, payload: { name: "cache" } })
      }).pipe(
        Effect.provide(
          Runtime.layer(
            { ...options, ...(cacheEnvironment === undefined ? {} : { cacheEnvironment }) },
            StepBoundary.layerUnsupported,
            WorkspaceSandbox.layerUnsupported,
            Interpreter.layer(Hello).pipe(
              Layer.provideMerge(Greet.toLayer(({ name }) =>
                Effect.map(Action.CurrentCacheEnvironment, (current) => {
                  seen.push(current)
                  return `hello ${name}`
                })
              )),
              Layer.provideMerge(Action.layerImplementations)
            )
          ).pipe(Layer.provide(OwnerIdentity.layerWithoutPid.pipe(Layer.provideMerge(Layer.mergeAll(
            NodeDatabase.layer({ filename: ":memory:" }),
            NodeCrypto.layer,
            Jj.layerNoop({})
          )))))
        ),
        Effect.scoped
      )
    )
  expect(await run(environment, "cache-declared")).toBe("hello cache")
  expect(await run(undefined, "cache-absent")).toBe("hello cache")
  expect(seen).toEqual([environment, undefined])
})
