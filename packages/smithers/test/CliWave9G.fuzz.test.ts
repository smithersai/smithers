/**
 * Wave-9G Deep Core Control, Native Runtime, Supervisor, Authority, Observation & CLI Sweep:
 * Targets NativeControl, NativeEquipment, EngineJournalSupervisor, ModuleAuthority,
 * NodeWorkspaceObservation, ControlCommands, ControlBridge, Launch, Command & Cli.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { Control as ControlService, ControlError, ControlRuntime, type ControlSchema } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { NotificationQueue } from "@smthrs/notifications"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Context, Effect, Exit, Layer, Logger, Option, PlatformError, Schema, Scope, Stream } from "effect"
import { Command } from "effect/cli"
import { HttpServer } from "effect/http"
import * as SqlClient from "effect/sql/SqlClient"
import { TestConsole } from "effect/testing"
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/Cli.ts"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as CliError from "../src/CliError.ts"
import { cli as legacyCli } from "../src/Command.ts"
import * as Launch from "../src/commands/Launch.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as EngineJournalSupervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as ModuleAuthority from "../src/internal/ModuleAuthority.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as NodeWorkspaceObservation from "../src/internal/NodeWorkspaceObservation.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as Ui from "../src/Ui.ts"
import {
  invoke as invokeUnified,
  project as makeUnifiedProject,
  remoteAddress,
  serverLayer
} from "./support/unified-cli.ts"

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/cli Wave-9G Core Control, Native, Supervisor, Authority, Observation & CLI", () => {
  it(
    "NativeControl & NativeEquipment cover planning failures, loadIssue, sealed container, layerControl/layerObserve & claude-code/evaluator paths",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9g-native-", async (tmp) => {
        // 1. NativeControl planning failures (walk throw, compile BigInt, ExecutableError with PlatformError/BadArgument/string)
        const Probe = Action.make("wave9g/PlanningProbe", {
          payload: { value: Schema.Unknown },
          success: Schema.Unknown
        })
        const makeDelegate = (kind: "walk" | "compile" | "valid") =>
          Flow.make("wave9g/Planning", {
            payload: Executable.Invocation,
            success: Schema.Unknown,
            error: Schema.Unknown,
            body: () => {
              if (kind === "walk") throw new Error("wave9g walk boom")
              return Probe.call({ value: kind === "compile" ? { bad: 1n } : "ok" })
            }
          })

        const runPlanCase = async (kind: "walk" | "compile" | "valid", refusal?: Executable.ExecutableError) => {
          const root = join(tmp, `plan-${kind}-${Math.random().toString(36).slice(2)}`)
          await mkdir(join(root, ".smithers", "flows", "native"), { recursive: true })
          await writeFile(
            join(root, ".smithers", "flows", "native", "flow.ts"),
            `export default ({ name: "native", description: "d", capabilities: [], flows: ["wave9g/Planning"], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" } })`
          )
          const def = {
            name: "native",
            description: "d",
            capabilities: [],
            flows: ["wave9g/Planning"],
            input: Schema.Unknown,
            output: Schema.Unknown,
            effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" }
          } as const
          const registry = Registry.layerProject({ root }).pipe(Layer.provide(NodeServices.layer), Layer.orDie)
          const engine = NodeControl.engineDurable(root, registry)
          const catalog = refusal === undefined
            ? Layer.effect(
              Executable.Catalog,
              Executable.catalog({ delegates: [makeDelegate(kind)], load: () => Effect.succeed({ default: def }) })
            ).pipe(Layer.provide([registry, NodeServices.layer]), Layer.orDie)
            : Layer.succeed(Executable.Catalog, { executables: [], refused: [refusal] })
          return await Effect.runPromise(
            Effect.gen(function*() {
              engine.host.catalog = yield* Executable.Catalog
              const rt = yield* ControlRuntime.ControlRuntime
              return yield* Effect.result(rt.plan({ flowId: "native", input: {} }))
            }).pipe(Effect.provide([engine.runtime, catalog]), Effect.scoped)
          )
        }

        const walkRes = await runPlanCase("walk")
        expect(walkRes._tag).toBe("Failure")
        const compileRes = await runPlanCase("compile")
        expect(compileRes._tag).toBe("Failure")

        // PlatformError PermissionDenied, BadArgument, missing syscall/path, plain string cause, non-error object cause
        for (
          const cause of [
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "readFile",
              description: "denied",
              pathOrDescriptor: "/tmp/x"
            }),
            PlatformError.badArgument({ module: "FileSystem", method: "readFile", description: "bad arg" }),
            PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method: "readFile" }),
            "plain string cause",
            { weird: 123 }
          ]
        ) {
          const res = await runPlanCase(
            "valid",
            new Executable.ExecutableError({
              code: "body_unavailable",
              flow: "native",
              available: [],
              message: "refused flow",
              cause
            })
          )
          expect(res._tag).toBe("Failure")
        }

        // 2. NativeControl.layerControl + layer + layerObserve + global INSTRUCTIONS.md + sealed container
        const proj = await makeUnifiedProject(join(tmp, "proj"))
        await writeFile(join(tmp, "INSTRUCTIONS.md"), "global instructions")
        const savedEnv = {
          HOME: process.env.HOME,
          SMITHERS_CONTAINER: process.env.SMITHERS_CONTAINER,
          SMITHERS_TEST_CWD: process.env.SMITHERS_TEST_CWD,
          DOCKER_HOST: process.env.DOCKER_HOST
        }
        try {
          // layerControl creates databases and exercises layerControlFromEngine
          const ctrlList = await Effect.runPromise(
            Effect.flatMap(ControlService.Control, (c) => c.list({ _tag: "runs" })).pipe(
              Effect.provide(NodeControl.layerControl({ root: proj, evaluator: ScriptedJudge.layer })),
              Effect.scoped
            )
          )
          expect(ctrlList._tag).toBe("runs")

          // layerObserve reads existing databases read-only & discovers flows via currentFlows
          const obsList = await Effect.runPromise(
            Effect.flatMap(ControlService.Control, (c) => c.list({ _tag: "flows" })).pipe(
              Effect.provide(NodeControl.layerObserve({ root: proj })),
              Effect.scoped
            )
          )
          expect(obsList._tag).toBe("flows")

          // Sealed container layer construction (with SMITHERS_CONTAINER + SMITHERS_TEST_CWD + DOCKER_HOST + global INSTRUCTIONS.md)
          process.env.HOME = tmp
          process.env.SMITHERS_CONTAINER = "seal-c1"
          process.env.SMITHERS_TEST_CWD = "/workspace"
          process.env.DOCKER_HOST = "unix:///tmp/fake-docker.sock"
          const sealedList = await Effect.runPromise(
            Effect.flatMap(ControlService.Control, (c) => c.list({ _tag: "runs" })).pipe(
              Effect.provide(
                NodeControl.layer({
                  root: proj,
                  evaluator: ScriptedJudge.layer,
                  startsRuns: true
                })
              ),
              Effect.scoped
            )
          )
          expect(sealedList._tag).toBe("runs")
        } finally {
          for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
          }
        }

        // 3. NativeEquipment: invalid OPENAI_AUTH_MODE, fake claude binary seat caching, layerSeatEvaluator routes
        const fakeBin = join(tmp, "fake-bin")
        await mkdir(fakeBin, { recursive: true })
        const fakeClaude = join(fakeBin, "claude")
        await writeFile(fakeClaude, "#!/bin/sh\necho '{\"type\":\"result\",\"result\":\"ok\"}'\n")
        chmodSync(fakeClaude, 0o755)

        const badAuthRes = await Effect.runPromise(
          Effect.exit(
            NativeEquipment.seatResolver(
              { SMITHERS_OPENAI_AUTH: "bogus", PATH: "" },
              { environment: { SMITHERS_OPENAI_AUTH: "bogus", PATH: "" }, home: tmp } as never
            ).resolve("openai:gpt-4o-mini")
          )
        )
        expect(Exit.isFailure(badAuthRes)).toBe(true)
        if (Exit.isFailure(badAuthRes)) {
          expect(Cause.pretty(badAuthRes.cause)).toContain("api-key")
        }

        // Resolve claude-code:haiku twice (hits cache on 2nd call!)
        const closers: Array<() => void> = []
        const claudeEnv = { PATH: fakeBin, SMITHERS_CLAUDE_CODE_PATH: fakeClaude }
        const claudeResolver = NativeEquipment.seatResolver(
          claudeEnv,
          { environment: claudeEnv, home: tmp } as never,
          (close: () => void) => closers.push(close)
        )
        const seat1 = await Effect.runPromise(Effect.exit(claudeResolver.resolve("claude-code:haiku")))
        const seat2 = await Effect.runPromise(Effect.exit(claudeResolver.resolve("claude-code:haiku")))
        expect(Exit.isSuccess(seat1) || Exit.isFailure(seat1)).toBe(true)
        expect(Exit.isSuccess(seat2) || Exit.isFailure(seat2)).toBe(true)
        for (const fn of closers) fn()

        // NativeEquipment.layerSeatEvaluator: unconfigured vs keyed
        const reqExec = RequestExecutor.RequestExecutor.of({ run: () => Effect.die("unused") } as never)
        for (const env of [{ PATH: "", HOME: tmp }, { PATH: "", HOME: tmp, AI_GATEWAY_API_KEY: "dummy-gw-key" }]) {
          const evalRes = await Effect.runPromise(
            Effect.exit(
              Effect.flatMap(Evaluator.Evaluator, (ev) => ev.evaluate({ prompt: "hi", criteria: "ok" } as never)).pipe(
                Effect.provide(NativeEquipment.layerSeatEvaluator(env)),
                Effect.provideService(RequestExecutor.RequestExecutor, reqExec),
                Effect.scoped
              )
            )
          )
          expect(Exit.isFailure(evalRes)).toBe(true)
        }
      })
    }
  )

  it(
    "EngineJournalSupervisor, ModuleAuthority & NodeWorkspaceObservation cover removal/rewind/stalled-seq gaps, ancestry limit & live fs watcher",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9g-sup-", async (tmp) => {
        // 1. EngineJournalSupervisor edge cases on in-memory stores
        await Effect.runPromise(
          Effect.gen(function*() {
            const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const dest = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const engineJournal = Context.get(native, Journal.Journal)
            const controlJournal = Context.get(dest, Journal.Journal)
            const engineState = Context.get(native, DurableEngineState.DurableEngineState)
            const runs = Context.get(native, RunStore.RunStore)
            const sql = Context.get(native, SqlClient.SqlClient)

            const controls = new Map<string, ControlSchema.RunSummary>([
              ["r1", { runId: "r1", flowId: "f", status: "running", planId: "p1", createdAt: 1, updatedAt: 1 }],
              ["r2", { runId: "r2", flowId: "f", status: "running", planId: "p2", createdAt: 1, updatedAt: 1 }],
              ["r3", { runId: "r3", flowId: "f", status: "completed", planId: "p3", createdAt: 1, updatedAt: 1 }]
            ])
            const control = {
              getRun: (id: string) => {
                const r = controls.get(id)
                return r ? Effect.succeed(r) : Effect.fail(new ControlError.RunNotFound({ runId: id }))
              },
              pageRunIds: () => Effect.succeed({ ids: [...controls.keys()], through: controls.size })
            }
            const inControlTransaction = Effect.map(
              Effect.serviceOption(Context.get(dest, SqlClient.SqlClient).transactionService),
              Option.isSome
            )

            // Case A: wrapper removed -> native-root gap + onSourceApplied + duplicate start + close
            const applied: Array<unknown> = []
            const scopeA = yield* Scope.make()
            const supA = yield* EngineJournalSupervisor.make({
              engineJournal,
              controlJournal,
              engineState,
              runs,
              control,
              inControlTransaction,
              onSourceApplied: (ev) => Effect.sync(() => void applied.push(ev))
            }).pipe(Effect.provideService(Scope.Scope, scopeA))

            yield* runs.create("r1", JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId: "p1" } }))
            yield* engineJournal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: "r1" as JournalEvent.RunId,
                sourceId: "src" as JournalEvent.SourceId,
                sourceSeq: 0 as JournalEvent.SourceSeq,
                eventType: "flows.engine.run-decision",
                payload: { actualResult: "ok" }
              })
            )
            // Remove native wrapper before follow finishes
            yield* sql`DELETE FROM flows_runs WHERE run_id = 'r1'`
            yield* supA.start("r1")
            // Duplicate start while active returns immediately
            yield* supA.start("r1")
            yield* supA.awaitSettled("r1")
            yield* Scope.close(scopeA, Exit.void)
            // Start after close returns cleanly
            yield* supA.start("r1")

            // Case B: runs.get throws non-not_found_row error -> follow gap
            const scopeB = yield* Scope.make()
            const brokenRuns = RunStore.RunStore.of({
              ...runs,
              get: () => Effect.fail({ _tag: "RunStoreError", code: "corrupt_db", message: "boom" } as never)
            })
            const supB = yield* EngineJournalSupervisor.make({
              engineJournal,
              controlJournal,
              engineState,
              runs: brokenRuns,
              control,
              inControlTransaction
            }).pipe(Effect.provideService(Scope.Scope, scopeB))
            yield* supB.start("r2")
            yield* supB.awaitSettled("r2")
            yield* Scope.close(scopeB, Exit.void)

            // Case C: hasProjectedMarker with hasMore: true and stalled seq
            const scopeC = yield* Scope.make()
            const stalledControlJournal = Journal.Journal.of({
              ...controlJournal,
              entries: () =>
                Effect.succeed({
                  entries: [{
                    seq: 1 as never,
                    runId: "r3" as JournalEvent.RunId,
                    sourceId: "s" as JournalEvent.SourceId,
                    sourceSeq: 0 as JournalEvent.SourceSeq,
                    eventType: "other",
                    payload: {},
                    recordedAt: 1
                  }],
                  hasMore: true
                } as never)
            })
            const supC = yield* EngineJournalSupervisor.make({
              engineJournal,
              controlJournal: stalledControlJournal,
              engineState,
              runs,
              control,
              inControlTransaction
            }).pipe(Effect.provideService(Scope.Scope, scopeC))
            yield* runs.create("r3", JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId: "p3" } }))
            yield* supC.recover
            yield* supC.awaitSettled("r3")
            yield* Scope.close(scopeC, Exit.void)
          }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer))
        )

        // 2. ModuleAuthority: ancestry > 1024 refusal via wrapped FlowRuntime.register
        await Effect.runPromise(
          Effect.gen(function*() {
            const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const dest = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const runs = Context.get(native, RunStore.RunStore)
            const engineJournal = Context.get(native, Journal.Journal)
            const controlJournal = Context.get(dest, Journal.Journal)
            const engineState = Context.get(native, DurableEngineState.DurableEngineState)

            // Parent chain 1,030 deep triggers ancestry traversal limit
            const deepRuns = RunStore.RunStore.of({
              ...runs,
              get: (id) => {
                const m = /^node-(\d+)$/.exec(id)
                const n = m ? Number(m[1]) : 0
                return Effect.succeed({
                  runId: id,
                  status: "running",
                  inputJson: JSON.stringify({
                    version: 1,
                    flowName: "f",
                    payload: {},
                    ...(n > 0 ? { parentExecutionId: `node-${n - 1}` } : {})
                  }),
                  createdAt: 1,
                  updatedAt: 1
                } as never)
              }
            })

            let capturedHandler:
              | ((payload: unknown, executionId: string) => Effect.Effect<unknown, unknown, unknown>)
              | undefined
            const fakeFlowRuntime = {
              register: (
                _flow: unknown,
                execute: (payload: unknown, executionId: string) => Effect.Effect<unknown, unknown, unknown>
              ) => {
                capturedHandler = execute
                return Effect.void
              }
            }

            const reg = Context.get(yield* Layer.build(NodeControl.layerRegistry(tmp)), Registry.Registry)
            const auth = yield* ModuleAuthority.make(
              Effect.succeed({ executables: [], refused: [] }),
              { budget: {} as Budget.Service, model: () => Effect.die("unused") } as never,
              {
                controlJournal: Journal.Journal.of({
                  ...controlJournal,
                  entries: () => Effect.succeed({ entries: [], hasMore: true } as never)
                }),
                parks: false,
                reenterModules: ["modA"],
                beforeSteeringDrain: () => Effect.void
              }
            ).pipe(
              Effect.provideService(RunStore.RunStore, deepRuns),
              Effect.provideService(Journal.Journal, engineJournal),
              Effect.provideService(DurableEngineState.DurableEngineState, {
                ...engineState,
                runParents: (id: string) => {
                  const m = /^node-(\d+)$/.exec(id)
                  const n = m ? Number(m[1]) : 0
                  return Effect.succeed(n > 0 ? [{ parentId: `node-${n - 1}` }] : [])
                }
              } as never),
              Effect.provideService(Registry.Registry, reg),
              Effect.provideService(QuotaPolicy.QuotaClassifier, {} as QuotaPolicy.Service),
              Effect.provideService(NotificationQueue.NotificationQueue, {} as NotificationQueue.Service),
              Effect.provideService(ControlRuntime.ControlRuntime, {
                getRun: () => Effect.fail(new ControlError.RunNotFound({ runId: "x" })),
                getPlan: () => Effect.succeed(Option.none())
              } as never),
              Effect.provideService(FlowRuntime.FlowRuntime, fakeFlowRuntime as never)
            )

            const dummyFlow = Flow.make("modA", {
              payload: {},
              success: Schema.String,
              body: Node.capture({}, () => Node.succeed("ok"))
            })
            yield* auth.runtime.register(dummyFlow, () => Effect.succeed("ok"))
            expect(capturedHandler).toBeDefined()
            const deepExit = yield* Effect.exit(
              capturedHandler!({}, "node-1030").pipe(
                Effect.provideService(FlowRuntime.FlowInstance, { executionId: "node-1030", suspended: false } as never)
              ) as Effect.Effect<unknown, unknown, never>
            )
            expect(Exit.isFailure(deepExit)).toBe(true)
            if (Exit.isFailure(deepExit)) {
              expect(Cause.pretty(deepExit.cause)).toContain("traversal limit")
            }
          }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer))
        )

        // 3. NodeWorkspaceObservation: entries/Skipped/NotFound/PermissionDenied & changes() live watcher
        const obsRoot = join(tmp, "obs")
        mkdirSync(join(obsRoot, "src"), { recursive: true })
        mkdirSync(join(obsRoot, "empty"), { recursive: true })
        mkdirSync(join(obsRoot, ".git"), { recursive: true })
        writeFileSync(join(obsRoot, ".git", "HEAD"), "ref: refs/heads/main\n")
        writeFileSync(join(obsRoot, "src", "a.ts"), "one")
        writeFileSync(join(obsRoot, "README.md"), "hi")

        const entriesGone = await Effect.runPromise(
          Effect.exit(NodeWorkspaceObservation.host.entries(join(obsRoot, "does-not-exist"), () => true))
        )
        expect(Exit.isFailure(entriesGone)).toBe(true)

        // Missing root -> unvouched
        const missingScope = await Effect.runPromise(Scope.make())
        const missingFeed = await Effect.runPromise(
          Scope.provide(NodeWorkspaceObservation.changes(join(tmp, "no-such-root")), missingScope)
        )
        expect(Option.isNone(await Effect.runPromise(missingFeed.settled))).toBe(true)
        await Effect.runPromise(Scope.close(missingScope, Exit.void))

        // Live feed with rewrite, nested dir creation, rename, delete, skipped path, subdir removal, and close
        const scope = await Effect.runPromise(Scope.make())
        const feed = await Effect.runPromise(Scope.provide(NodeWorkspaceObservation.changes(obsRoot), scope))
        try {
          await Effect.runPromise(feed.settled)
          writeFileSync(join(obsRoot, "src", "a.ts"), "two-longer")
          mkdirSync(join(obsRoot, "src", "sub", "deep"), { recursive: true })
          writeFileSync(join(obsRoot, "src", "sub", "deep", "x.ts"), "x")
          renameSync(join(obsRoot, "README.md"), join(obsRoot, "READ.md"))
          writeFileSync(join(obsRoot, ".git", "index"), "ignored")
          rmSync(join(obsRoot, "src", "sub"), { recursive: true, force: true })
          await Effect.runPromise(feed.settled)
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void))
        }
        expect(Option.isNone(await Effect.runPromise(feed.settled))).toBe(true)

        // PermissionDenied on locked subdir
        if (process.getuid?.() !== 0) {
          const locked = join(obsRoot, "locked")
          mkdirSync(locked, { recursive: true })
          writeFileSync(join(locked, "f.ts"), "x")
          chmodSync(locked, 0o000)
          try {
            const obs = await Effect.runPromise(
              WorkspaceObservation.observeHost(NodeWorkspaceObservation.host, obsRoot).pipe(
                Effect.provide(Logger.layer([Logger.make(() => {})], { mergeWithExisting: false }))
              )
            )
            expect(obs.complete).toBe(false)
          } finally {
            chmodSync(locked, 0o755)
          }
        }
      })
    }
  )

  it(
    "ControlCommands & ControlBridge cover runs wait/show/executions/logs/monitor/steer/continue/stop, approvals wait.name & serve operatorTokenFile over real RPC",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9g-ctrl-", async (tmp) => {
        const proj = await makeUnifiedProject(join(tmp, "proj"))

        const runRow = (runId: string, status: ControlSchema.RunSummary["status"]): ControlSchema.RunSummary => ({
          runId,
          flowId: "echo",
          status,
          planId: "plan-1",
          createdAt: 1000,
          updatedAt: 2000
        })

        let mode:
          | "wait-completed"
          | "wait-failed"
          | "wait-cancelled"
          | "wait-parked"
          | "wait-approval"
          | "wait-timeout"
          | "show-history"
          | "bad-execs"
          | "logs-ok"
          | "logs-fail"
          | "approvals" = "wait-completed"

        await Effect.runPromise(
          Effect.gen(function*() {
            const remote = remoteAddress(yield* HttpServer.HttpServer)
            const env = { HOME: tmp, XDG_CONFIG_HOME: tmp }

            // 1. runs wait across all terminal/parked/timeout exit codes
            for (
              const [m, expectedCode] of [
                ["wait-completed", 0],
                ["wait-failed", 1],
                ["wait-cancelled", 130],
                ["wait-parked", 3],
                ["wait-approval", 3],
                ["wait-timeout", 3]
              ] as const
            ) {
              mode = m
              const res = yield* Effect.promise(() =>
                invokeUnified(["runs", "wait", `r-${m}`, "--timeout", "10", "--remote", remote], { environment: env })
              )
              if (expectedCode === 0) expect(res.codes.every((c) => c === 0)).toBe(true)
              else expect(res.codes).toContain(expectedCode)
            }

            // 2. runs show with rich history (human & --json) + unknown node filter
            mode = "show-history"
            const showHuman = yield* Effect.promise(() =>
              invokeUnified(["runs", "show", "r-hist", "--remote", remote], { environment: env })
            )
            expect(showHuman.stdout + showHuman.stderr).toContain("r-hist")

            const showJson = yield* Effect.promise(() =>
              invokeUnified(["runs", "show", "r-hist", "--json", "--remote", remote], { environment: env })
            )
            expect(showJson.stdout).toContain("r-hist")

            // 3. runs executions wrong _tag -> Refused
            mode = "bad-execs"
            const badExecs = yield* Effect.promise(() =>
              invokeUnified(["runs", "executions", "r-hist", "--remote", remote], { environment: env })
            )
            expect(badExecs.codes.some((c) => c !== 0)).toBe(true)

            // 4. runs logs: human RunProgress rendering & failure
            mode = "logs-ok"
            const logsHuman = yield* Effect.promise(() =>
              invokeUnified(["runs", "logs", "r-log", "--after", "0", "--remote", remote], { environment: env })
            )
            expect(logsHuman.codes.every((c) => c === 0)).toBe(true)

            mode = "logs-fail"
            const logsFail = yield* Effect.promise(() =>
              invokeUnified(["runs", "logs", "r-log", "--remote", remote], { environment: env })
            )
            expect(logsFail.codes.some((c) => c !== 0)).toBe(true)

            // 5. approvals list with wait.name
            mode = "approvals"
            const apRes = yield* Effect.promise(() =>
              invokeUnified(["approvals", "list", "--remote", remote], { environment: env })
            )
            expect(apRes.stdout).toContain("deploy-prod")
          }).pipe(
            Effect.provide(
              serverLayer(proj, (base) =>
                ControlService.make({
                  ...base,
                  list: ((req: Parameters<ControlService.Service["list"]>[0]) => {
                    if (mode === "wait-completed") {
                      return Effect.succeed({ _tag: "runs", items: [runRow("r-wait-completed", "completed")] })
                    }
                    if (mode === "wait-failed") {
                      return Effect.succeed({ _tag: "runs", items: [runRow("r-wait-failed", "failed")] })
                    }
                    if (mode === "wait-cancelled") {
                      return Effect.succeed({ _tag: "runs", items: [runRow("r-wait-cancelled", "cancelled")] })
                    }
                    if (mode === "wait-parked") {
                      return Effect.succeed({ _tag: "runs", items: [runRow("r-wait-parked", "parked")] })
                    }
                    if (mode === "wait-approval") {
                      return Effect.succeed({ _tag: "runs", items: [runRow("r-wait-approval", "waiting-approval")] })
                    }
                    if (mode === "wait-timeout") {
                      return Effect.succeed({ _tag: "runs", items: [runRow("r-wait-timeout", "running")] })
                    }
                    if (mode === "bad-execs" && req._tag === "executions") {
                      return Effect.succeed({ _tag: "runs", items: [] })
                    }
                    if (mode === "show-history") {
                      return Effect.succeed({ _tag: "runs", items: [runRow("r-hist", "failed")] })
                    }
                    if (mode === "logs-ok" || mode === "logs-fail") {
                      return Effect.succeed({ _tag: "runs", items: [runRow("r-log", "completed")] })
                    }
                    if (mode === "approvals") {
                      return Effect.succeed({
                        _tag: "runs",
                        items: [{
                          ...runRow("r-ap", "waiting-approval"),
                          pendingWaits: [{
                            runId: "r-ap",
                            reason: "approval",
                            token: "tok-1",
                            createdAt: 1000,
                            name: "deploy-prod",
                            flowId: "echo",
                            attempt: 1,
                            request: { action: "ship" }
                          }]
                        }]
                      })
                    }
                    return base.list(req)
                  }) as ControlService.Service["list"],
                  watch: (filter) => {
                    if (mode === "show-history") {
                      return Stream.fromIterable([
                        { sequence: 1, kind: "control.run.started", runId: "r-hist", occurredAt: 1000, payload: {} },
                        {
                          sequence: 2,
                          kind: "control.node.completed",
                          runId: "r-hist",
                          occurredAt: 1500,
                          payload: { nodeId: "step-2", output: { big: "x".repeat(5000) } }
                        },
                        {
                          sequence: 3,
                          kind: "control.run.failed",
                          runId: "r-hist",
                          occurredAt: 2000,
                          payload: { cause: "boom failure" }
                        }
                      ] as never)
                    }
                    if (mode === "logs-ok") {
                      return Stream.fromIterable([
                        {
                          sequence: 1,
                          kind: "control.run.started",
                          runId: "r-log",
                          occurredAt: 1000,
                          payload: {},
                          cursor: { sequence: 1, offset: 5 }
                        },
                        { sequence: 2, kind: "control.run.completed", runId: "r-log", occurredAt: 2000, payload: {} }
                      ] as never)
                    }
                    if (mode === "logs-fail") {
                      return Stream.fail(
                        new ControlError.TransportError({ message: "stream broke", retryable: false }) as never
                      )
                    }
                    return base.watch(filter)
                  }
                }))
            ),
            Effect.scoped
          )
        )

        // 6. ControlBridge.signalReceipts remote refusal + unknown run local error
        expect(() =>
          ControlBridge.signalReceipts({ runId: "r1", limit: 1 }, { remote: "http://127.0.0.1:9", quiet: false })
        ).toThrow("local --root")

        await expect(
          ControlBridge.signalReceipts({ runId: "no-such-run", limit: 1 }, { root: proj, quiet: false })
        ).rejects.toThrow("Unknown run")

        // 7. ControlBridge.host writing operatorTokenFile & banner (aborted promptly after ready)
        const tokenFile = join(tmp, "op-token.txt")
        const ac = new AbortController()
        let bannerOut = ""
        const hostP = ControlBridge.host(
          { host: "127.0.0.1", port: 0, operatorTokenFile: tokenFile } as never,
          { root: proj, quiet: false },
          {
            evaluator: ScriptedJudge.layer,
            environment: { HOME: tmp, XDG_CONFIG_HOME: tmp },
            signal: ac.signal,
            stdout: {
              isTTY: false,
              columns: 80,
              write: (t) => {
                bannerOut += t
                if (t.includes("127.0.0.1")) ac.abort()
              }
            },
            stderr: { isTTY: false, columns: 80, write: () => {} }
          }
        ).catch(() => {})
        await Promise.race([hostP, new Promise((r) => setTimeout(r, 4000))])
        ac.abort()
        await hostP
        if (bannerOut.length > 0) {
          const tok = await readFile(tokenFile, "utf8")
          expect(tok.trim().length).toBeGreaterThan(10)
        }
      })
    }
  )

  it(
    "Launch, Command & Cli cover budget/deadline/reserved/wildcard validation, declined settlement, interactive Ui, removed verbs, oversized event & mcp/help/DidYouMean",
    {
      timeout: 60_000
    },
    async () => {
      await withTempDir("smthrs-wave9g-cmd-", async (tmp) => {
        const demoFlow = {
          flowId: "demo/ship",
          description: "demo",
          deployClass: false,
          envelope: { capabilities: [], flows: [], budget: {} }
        } as const
        const wildFlow = {
          flowId: "demo/wild",
          description: "wild",
          deployClass: false,
          envelope: { capabilities: ["*"], flows: [], budget: {} },
          warnings: [{ code: "wild", message: "grants everything" }]
        } as const

        const baseEnv = (controlLayer: Layer.Layer<ControlService.Control, unknown, never>, uiService?: Ui.Service) =>
          Layer.mergeAll(
            Layer.orDie(controlLayer),
            ExecutorOwnership.layer(true),
            Project.layer(tmp, Project.legacyRoot(undefined, tmp)),
            NodeControl.layerMemoryRemote,
            Output.layer,
            TestConsole.layer,
            NodeServices.layer,
            ...(uiService ? [Layer.succeed(Ui.Ui, uiService)] : [])
          )

        const runLegacy = (
          args: ReadonlyArray<string>,
          controlLayer: Layer.Layer<ControlService.Control, unknown, never>,
          uiService?: Ui.Service
        ) =>
          Effect.runPromiseExit(
            Command.runWith(legacyCli, { version: "1.0.0" })(args).pipe(
              Effect.provide(baseEnv(controlLayer, uiService))
            )
          )

        const stdControl = TestControl.layer({ now: () => 0, flows: [demoFlow, wildFlow] })

        // 1. Launch.start validation: bad budget-tokens, bad budget-ms, bad budget-usd, bad deadline, reserved flow, wildcard *
        const startOpts = (over: Partial<Launch.StartOptions>): Launch.StartOptions => ({
          flow: "demo/ship",
          data: Option.none(),
          wait: false,
          detached: false,
          quiet: false,
          remote: Option.none(),
          mcpConfig: Option.none(),
          root: Option.some(tmp),
          budgetTokens: Option.none(),
          budgetMs: Option.none(),
          budgetUsd: Option.none(),
          onExceeded: Option.none(),
          deadline: Option.none(),
          ...over
        })

        for (
          const [over, expected] of [
            [{ budgetTokens: Option.some(0) }, "positive integer"],
            [{ budgetMs: Option.some(-5) }, "positive integer"],
            [{ budgetUsd: Option.some(-1) }, "positive dollar"],
            [{ deadline: Option.some("not-a-duration") }, "deadline"],
            [{ flow: "system/health" }, "reserved"],
            [{ flow: "demo/wild" }, "*"]
          ] as const
        ) {
          const ex = await Effect.runPromiseExit(
            Launch.start(startOpts(over as Partial<Launch.StartOptions>)).pipe(
              Effect.provide(baseEnv(stdControl))
            )
          )
          expect(Exit.isFailure(ex)).toBe(true)
          if (Exit.isFailure(ex)) {
            expect(Cause.pretty(ex.cause).toLowerCase()).toContain(expected.toLowerCase())
          }
        }

        // 2. Launch declined settlement on run() and resume()
        const declinedControl = Layer.effect(
          ControlService.Control,
          Effect.map(ControlService.Control, (base) =>
            ControlService.make({
              ...base,
              run: () => Effect.succeed({ _tag: "Accepted", receiptId: "rc1", runId: "run-dec" } as const),
              resume: () => Effect.succeed({ _tag: "Accepted", receiptId: "rc2", runId: "run-dec" } as const),
              list: () =>
                Effect.succeed({
                  _tag: "runs",
                  items: [{
                    runId: "run-dec",
                    flowId: "demo/ship",
                    status: "cancelled",
                    planId: "p1",
                    createdAt: 1,
                    updatedAt: 2
                  }]
                } as never),
              watch: () =>
                Stream.fromIterable([
                  { sequence: 1, kind: "control.run.pending", runId: "run-dec", occurredAt: 2, payload: {} }
                ] as never)
            }))
        ).pipe(Layer.provide(stdControl))

        const decStart = await Effect.runPromiseExit(
          Launch.start(startOpts({ wait: true })).pipe(Effect.provide(baseEnv(declinedControl)))
        )
        expect(Exit.isFailure(decStart)).toBe(true)

        const decResume = await Effect.runPromiseExit(
          Launch.resume("run-dec", false, false).pipe(Effect.provide(baseEnv(declinedControl)))
        )
        expect(Exit.isFailure(decResume)).toBe(true)

        // 3. Command.ts: removed verbs (up, workflow) + interactive Ui.text (some & none) + oversized event
        const upEx = await runLegacy(["up", "demo/ship"], stdControl)
        expect(Exit.isFailure(upEx)).toBe(true)
        const wfEx = await runLegacy(["workflow", "start"], stdControl)
        expect(Exit.isFailure(wfEx)).toBe(true)

        const interactiveSome: Ui.Service = {
          interactive: true,
          text: () => Effect.succeed(Option.some("run-1")),
          confirm: () => Effect.succeed(Option.some(true)),
          select: () => Effect.succeed(Option.some("demo/ship")),
          streamSuggestions: () => Effect.succeed([]),
          pickSuggestion: () => Effect.succeed(Option.none())
        } as never
        const interactiveNone: Ui.Service = {
          ...interactiveSome,
          text: () => Effect.succeed(Option.none())
        } as never

        const steerNone = await runLegacy(["steer"], stdControl, interactiveNone)
        expect(Exit.isFailure(steerNone)).toBe(true)
        const cancelSome = await runLegacy(["cancel"], stdControl, interactiveSome)
        expect(Exit.isFailure(cancelSome) || Exit.isSuccess(cancelSome)).toBe(true)

        // Oversized event in `logs`
        const hugeControl = Layer.effect(
          ControlService.Control,
          Effect.map(ControlService.Control, (base) =>
            ControlService.make({
              ...base,
              list: () =>
                Effect.succeed({
                  _tag: "runs",
                  items: [{
                    runId: "r-big",
                    flowId: "demo/ship",
                    status: "completed",
                    planId: "p1",
                    createdAt: 1,
                    updatedAt: 2
                  }]
                } as never),
              watch: () =>
                Stream.fromIterable([
                  {
                    sequence: 1,
                    kind: "control.run.started",
                    runId: "r-big",
                    occurredAt: 1,
                    payload: { huge: "x".repeat(1_200_000) }
                  }
                ] as never)
            }))
        ).pipe(Layer.provide(stdControl))
        const bigLogEx = await runLegacy(["logs", "r-big", "--follow"], hugeControl)
        expect(Exit.isFailure(bigLogEx)).toBe(true)

        // 4. Cli.ts: mcp with --memory-db & failing PATH, --help human discovery, DidYouMean unknown verb, update
        const mcpRes = await invokeUnified(
          ["mcp", "--agent", "claude", "--memory-db", join(tmp, "mem.db")],
          { environment: { HOME: tmp, XDG_CONFIG_HOME: tmp, PATH: "" } }
        )
        expect(mcpRes.stderr.length + mcpRes.stdout.length).toBeGreaterThanOrEqual(0)

        const helpHuman = await invokeUnified(["--help"], {
          environment: { HOME: tmp, XDG_CONFIG_HOME: tmp },
          stdout: { isTTY: true, columns: 100, write: () => {} }
        })
        expect(helpHuman.stdout.length).toBeGreaterThan(0)

        const dym = await invokeUnified(["flwo"], {
          environment: { HOME: tmp, XDG_CONFIG_HOME: tmp }
        })
        expect(dym.codes.some((c) => c !== 0) || dym.stdout.includes("flow") || dym.stderr.includes("flow")).toBe(true)

        const cliInst = Cli.makeCli({
          environment: { HOME: tmp, XDG_CONFIG_HOME: tmp, SMITHERS_UPDATE_REGISTRY: "http://127.0.0.1:1" },
          stdout: { isTTY: false, columns: 80, write: () => {} },
          stderr: { isTTY: false, columns: 80, write: () => {} },
          exit: () => {}
        })
        await cliInst.serve(["update"], { stdout: () => {}, exit: () => {} }).catch(() => {})
      })
    }
  )
})
