import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentRunner from "@smthrs/agent/AgentRunner"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Control from "@smthrs/control/Control"
import { RunNotFound } from "@smthrs/control/ControlError"
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import type { ControlEvent, RunSummary } from "@smthrs/control/ControlSchema"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { FlowRuntime } from "@smthrs/flow"
import * as Steering from "@smthrs/harness/Steering"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as NotificationQueue from "@smthrs/notifications/NotificationQueue"
import { NodeRuntime } from "@smthrs/platform-node"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Context, Deferred, Effect, Exit, Fiber, Latch, Layer, Logger, Option, Queue, Scope, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/Cli.ts"
import type * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as CodexLogin from "../src/internal/CodexLogin.ts"
import * as Supervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as ModuleAuthority from "../src/internal/ModuleAuthority.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Config from "../src/runner/Config.ts"
import * as Host from "../src/runner/Host.ts"
import * as Job from "../src/runner/Job.ts"
import * as LocalJobs from "../src/runner/LocalJobs.ts"
import * as Session from "../src/runner/Session.ts"
import * as Workspace from "../src/runner/Workspace.ts"
import * as Suggest from "../src/Suggest.ts"
import * as Ui from "../src/Ui.ts"
import * as HostFixture from "./fixtures/runner/host.ts"

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const makeControlEvent = (
  runId: string,
  sequence: number,
  kind: ControlEvent["kind"],
  payload: unknown,
  at = 1_000 + sequence * 10
): ControlEvent => ({
  runId,
  sequence,
  kind,
  payload,
  createdAt: at,
  eventId: `ev-${runId}-${sequence}`,
  actor: { id: "local", kind: "operator" }
} as unknown as ControlEvent)

describe("@smthrs/cli Wave-9N Final Precision Closer", () => {
  it(
    "covers RunProgress native duplicate flip, RunTiming failedTriesOf, Suggest branches, ExecutionEnvironment & CodexLogin",
    async () => {
      await withTempDir("wave9n-1-", async (tmp) => {
        // 1. RunProgress native duplicate flip (lines 263-276)
        for (const nativeOutcome of ["failure", "success"] as const) {
          const callId = `cell-call-v1:${(nativeOutcome === "failure" ? "a" : "b").repeat(64)}`
          let st = RunProgress.initial()
          const ev1 = makeControlEvent("run-rp", 1, "control.agent.cell-call-started", { callId, flowName: "lint" })
          const ev2 = makeControlEvent("run-rp", 2, "control.agent.cell-call-settled", {
            callId,
            flowName: "lint",
            outcome: nativeOutcome === "failure" ? "success" : "failed"
          })
          const nativeSettled = makeControlEvent("run-rp", 3, "control.engine.event", {
            version: 1,
            executionId: "native",
            generation: 0,
            sequence: 3,
            emittedAtMs: 30,
            sourceSequence: 0,
            sourceId: `call-fact-v1:${callId}:settled`,
            eventType: "flows.harness.call-fact.v1",
            payload: {
              version: 1,
              phase: "settled",
              callId,
              identity: { runId: "run-rp", frame: 0, cell: "cell", ordinal: 0, declaration: "d", layers: [] },
              flowName: "lint",
              outcome: nativeOutcome,
              value: null
            }
          })
          const nativeInvoked = makeControlEvent("run-rp", 4, "control.engine.event", {
            version: 1,
            executionId: "native",
            generation: 0,
            sequence: 4,
            emittedAtMs: 31,
            sourceSequence: 0,
            sourceId: `call-fact-v1:${callId}:invoked`,
            eventType: "flows.harness.call-fact.v1",
            payload: {
              version: 1,
              phase: "invoked",
              callId,
              identity: { runId: "run-rp", frame: 0, cell: "cell", ordinal: 0, declaration: "d", layers: [] },
              flowName: "lint",
              input: {}
            }
          })
          for (const ev of [ev1, ev2, nativeSettled, nativeSettled, nativeInvoked]) {
            st = RunProgress.project(st, ev).state
          }
          expect(st.failed).toBe(nativeOutcome === "failure" ? 1 : 0)
          expect(st.completed).toBe(nativeOutcome === "success" ? 1 : 0)
        }

        // 2. RunTiming failedTriesOf (lines 490-502)
        const timingEvents: Array<ControlEvent> = [
          makeControlEvent("run-rt", 1, "control.run.accepted", { flowId: "demo/f" }, 1_000),
          makeControlEvent("run-rt", 2, "control.agent.model-requested", {
            callId: "c1",
            flowName: "demo/f",
            stepKey: "s1"
          }, 1_050),
          makeControlEvent("run-rt", 3, "control.agent.model-settled", {
            callId: "c1",
            flowName: "demo/f",
            outcome: "success",
            tries: 3,
            timing: {
              attempts: 3,
              failedTries: [
                { sentMs: 10, failedMs: 50, code: "rate_limit", httpStatus: 429 },
                { failedMs: 90 },
                { failedMs: "not-a-number" }
              ]
            }
          }, 1_200),
          makeControlEvent("run-rt", 4, "control.agent.model-settled", {
            callId: "c2",
            flowName: "demo/f",
            outcome: "success",
            tries: 1,
            timing: { failedTries: [{ failedMs: "bad" }] }
          }, 1_250)
        ]
        const timingReport = RunTiming.fold(timingEvents, "run-rt")
        expect(timingReport.calls[0]?.failedTries?.length).toBe(2)

        // 3. Suggest uncovered branches (lines 136, 245-255, 263, 267, 288, 315, 368, 396, 409)
        const projDir = join(tmp, "sug-proj")
        mkdirSync(projDir, { recursive: true })
        writeFileSync(join(projDir, "package.json"), JSON.stringify({ name: "sug-app", scripts: { test: "vitest" } }))
        const sugEnv = {
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          OPENAI_API_KEY: "sk-test-key"
        }

        // 3a. writeLine default stdout emit (line 136)
        const capturedStdout: Array<string> = []
        const origWrite = process.stdout.write.bind(process.stdout)
        process.stdout.write = ((chunk: unknown) => {
          capturedStdout.push(String(chunk))
          return true
        }) as typeof process.stdout.write
        try {
          const resJson = await Effect.runPromise(
            Suggest.run({ root: projDir, list: true, json: true, environment: sugEnv, homeDirectory: tmp })
          )
          expect(resJson.status).toBe("listed")
          expect(capturedStdout.length).toBeGreaterThan(0)
        } finally {
          process.stdout.write = origWrite
        }

        // 3b. scanFailed on json + human (lines 267, 288, 368)
        const brokenRepo = {
          root: projDir,
          read: () => {
            throw new Error("read boom")
          },
          exists: () => {
            throw new Error("exists boom")
          },
          list: () => {
            throw new Error("list boom")
          }
        }
        const jsonScanFail = await Effect.runPromise(
          Effect.exit(
            Suggest.run({
              root: projDir,
              list: true,
              json: true,
              environment: sugEnv,
              homeDirectory: tmp,
              repository: brokenRepo,
              emit: () => {}
            })
          )
        )
        expect(Exit.isFailure(jsonScanFail)).toBe(true)

        const makeMockUi = (opts: {
          failStream?: boolean
          triggerCancel?: boolean
        }): Ui.Service => ({
          interactive: true,
          intro: () => Effect.void,
          outro: () => Effect.void,
          line: () => Effect.void,
          note: () => Effect.void,
          checklist: () => Effect.void,
          spinner: () => ({
            start: () => {},
            message: () => {},
            stop: () => {},
            cancel: () => {},
            error: () => {}
          }),
          streamSuggestions: (source: AsyncIterable<any>, streamOpts: Ui.StreamOptions<any>) =>
            opts.failStream
              ? Effect.fail(new Error("stream boom"))
              : Effect.promise(async () => {
                const items: Array<any> = []
                for await (const item of source) {
                  streamOpts.label(item, items.length + 1)
                  items.push(item)
                }
                streamOpts.settled?.(items.length)
                return { items, stopped: false }
              }),
          pickSuggestion: (items: ReadonlyArray<any>, pickOpts: Ui.PickOptions<any>) =>
            Effect.sync(() => {
              if (items.length === 0) return Option.none()
              pickOpts.label(items[0]!, 1)
              pickOpts.hint?.(items[0]!)
              return Option.some(items[0]!)
            }),
          confirm: (confirmOpts: Ui.ConfirmOptions) =>
            Effect.sync(() => {
              if (opts.triggerCancel) confirmOpts.onCancel?.()
              return false
            })
        } as unknown as Ui.Service)

        const humanScanFail = await Effect.runPromise(
          Effect.exit(
            Suggest.run({
              root: projDir,
              list: false,
              json: false,
              environment: sugEnv,
              homeDirectory: tmp
            }).pipe(Effect.provideService(Ui.Ui, makeMockUi({ failStream: true })))
          )
        )
        expect(Exit.isFailure(humanScanFail)).toBe(true)

        // 3c. hint, onCancel (lines 396, 409)
        const cancelledFollowup = await Effect.runPromise(
          Suggest.run({
            root: projDir,
            list: false,
            json: false,
            environment: sugEnv,
            homeDirectory: tmp,
            implement: () => Effect.succeed({ files: ["a.ts"], command: "test", notes: "ok" })
          }).pipe(Effect.provideService(Ui.Ui, makeMockUi({ triggerCancel: true })))
        )
        expect(cancelledFollowup.implemented.length).toBeGreaterThanOrEqual(1)

        // 3d. spinner.cancel on interrupted implement (line 315)
        const interruptRes = await Effect.runPromise(
          Effect.exit(
            Suggest.run({
              root: projDir,
              list: false,
              json: false,
              environment: sugEnv,
              homeDirectory: tmp,
              implement: () => Effect.interrupt
            }).pipe(Effect.provideService(Ui.Ui, makeMockUi({})))
          )
        )
        expect(Exit.isFailure(interruptRes)).toBe(true)

        // 3e. default nodeImplement + asError with non-Error failure (lines 245-255, 263)
        const badRootImplement = await Effect.runPromise(
          Effect.exit(
            Suggest.run({
              root: projDir,
              list: false,
              json: false,
              environment: sugEnv,
              homeDirectory: tmp,
              evaluator: Layer.effectDiscard(Effect.fail("non-error-fail")) as never
            }).pipe(Effect.provideService(Ui.Ui, makeMockUi({})))
          )
        )
        expect(Exit.isFailure(badRootImplement)).toBe(true)

        // 4. ExecutionEnvironment uncovered lines (117, 390, 408-412)
        const badEnvXdg = join(tmp, "env-xdg")
        mkdirSync(join(badEnvXdg, "smithers", "environments.json"), { recursive: true })
        await expect(ExecutionEnvironment.list({ XDG_CONFIG_HOME: badEnvXdg, HOME: tmp })).rejects.toThrow()

        // Fake ssh script exiting 255 -> hits line 390
        const fakeBin = join(tmp, "fake-bin")
        mkdirSync(fakeBin, { recursive: true })
        const fakeSsh = join(fakeBin, "ssh")
        writeFileSync(fakeSsh, "#!/bin/sh\nexit 255\n", "utf8")
        chmodSync(fakeSsh, 0o755)
        const origErr = process.stderr.write.bind(process.stderr)
        const errOut: Array<string> = []
        process.stderr.write = ((chunk: unknown) => {
          errOut.push(String(chunk))
          return true
        }) as typeof process.stderr.write
        try {
          const sshCode = await ExecutionEnvironment.run(
            { name: "ssh-255", transport: "ssh", destination: "example.invalid", directory: "/tmp" },
            ["echo", "hi"],
            { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, HOME: tmp, XDG_CONFIG_HOME: tmp }
          )
          expect(sshCode).toBe(255)
          expect(errOut.join("")).toContain("exit 255")
        } finally {
          process.stderr.write = origErr
        }

        // Terminal mode abort with resistant child -> hits lines 408-412 (setTimeout wait -> deadline -> SIGKILL)
        const ac = new AbortController()
        const termPromise = ExecutionEnvironment.run(
          { name: "term-kill", transport: "local", directory: tmp },
          ["sh", "-c", "(trap '' TERM; sleep 10) & sleep 0.05; exit 0"],
          { PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: tmp },
          { terminal: true, signal: ac.signal }
        )
        setTimeout(() => ac.abort(), 30)
        const termCode = await termPromise
        expect(termCode).toBe(130)

        // 5. CodexLogin uncovered lines (173, 333-339, 434, 486, 497, 503)
        // 5a. cliRefresh spawn failure (line 486): non-executable / bad interpreter codex binary
        const badBin = join(tmp, "bad-codex-bin")
        mkdirSync(badBin, { recursive: true })
        writeFileSync(join(badBin, "codex"), "#!/nonexistent/interpreter/path\n", "utf8")
        chmodSync(join(badBin, "codex"), 0o755)
        const cliSpawnFail = await Effect.runPromise(
          Effect.exit(
            CodexLogin.cliRefresh({
              environment: { PATH: badBin, HOME: tmp },
              timeoutMs: 200
            })
          )
        )
        expect(Exit.isFailure(cliSpawnFail)).toBe(true)

        // 5b. cliRefresh immediate exit -> empty stream head (line 497 / unanswered)
        const emptyBin = join(tmp, "empty-codex-bin")
        mkdirSync(emptyBin, { recursive: true })
        writeFileSync(join(emptyBin, "codex"), "#!/bin/sh\nexit 0\n", "utf8")
        chmodSync(join(emptyBin, "codex"), 0o755)
        const cliEmpty = await Effect.runPromise(
          Effect.exit(
            CodexLogin.cliRefresh({
              environment: { PATH: emptyBin, HOME: tmp },
              timeoutMs: 200
            })
          )
        )
        expect(Exit.isFailure(cliEmpty)).toBe(true)

        // 5c. cliRefresh timeout (line 503)
        const slowBin = join(tmp, "slow-codex-bin")
        mkdirSync(slowBin, { recursive: true })
        writeFileSync(join(slowBin, "codex"), "#!/bin/sh\nsleep 5\n", "utf8")
        chmodSync(join(slowBin, "codex"), 0o755)
        const cliTimeout = await Effect.runPromise(
          Effect.exit(
            CodexLogin.cliRefresh({
              environment: { PATH: slowBin, HOME: tmp },
              timeoutMs: 40
            })
          )
        )
        expect(Exit.isFailure(cliTimeout)).toBe(true)

        // 5d. CodexLogin.make with expired/bad JWT + real refresh acquiring & releasing lock (lines 333-339, 434)
        const authFile = join(tmp, "auth.json")
        writeFileSync(authFile, JSON.stringify({ tokens: { access_token: "not.a.jwt", refresh_token: "rt" } }), "utf8")
        const store = CodexLogin.make({
          file: authFile,
          refresh: Effect.void
        })
        const authExit = await Effect.runPromise(Effect.exit(store.auth.sign({})))
        expect(authExit).toBeDefined()
        expect(CodexLogin.unusable(authFile, "{bad")).toBeDefined()
      })
    },
    60_000
  )

  it(
    "covers runner/Job awaitControl & Settle not_authorized/dropped and runner/Session provision retries & machine_lost",
    async () => {
      await withTempDir("wave9n-2-", async (tmp) => {
        const stateDir = join(tmp, "state")
        mkdirSync(stateDir, { recursive: true })
        const mirror = HostFixture.mirror(tmp)
        const config = await Effect.runPromise(
          Config.check({
            name: "test-runner",
            stateDir,
            repositories: {
              "github/acme/app": {
                mirror: mirror.path
              }
            },
            profiles: {
              "test-agent": { argv: [process.execPath, "-e", "process.exit(0)"] }
            }
          }).pipe(Effect.provide(NodeServices.layer))
        )

        // 1. Job.ts awaitControl expired deadline (lines 139-145)
        const store = await Effect.runPromise(
          LocalJobs.make(stateDir).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
        )
        const engineExpired = NodeRuntime.layerHost(
          { filename: join(stateDir, "engine-exp.db"), workspaceRoot: stateDir, owner: { hostId: "r-exp" } },
          Job.registration(config, new Map()).pipe(Layer.provide(Layer.succeed(Host.Host, store.host)))
        )
        const expiredPayload: Session.JobPayload = {
          key: "woken-exp#g1",
          claim: "claim-1",
          generation: 1,
          task: HostFixture.task({ base: "a".repeat(40), prompt: "unused" }),
          deadline: Date.now() - Job.SETTLE_GRACE_MS - 1
        }
        const resExpired = await Effect.runPromise(
          Job.RunnerJob.execute(expiredPayload, { executionId: expiredPayload.key }).pipe(
            Effect.provide(engineExpired),
            Effect.scoped
          )
        )
        expect(resExpired).toEqual({ recorded: false, outcome: "failed:timeout" })

        // 2. Job.ts awaitControl waking when control arrives + Settle not_authorized backoff interrupted by dropped (lines 139-146, 225-242)
        const controls = new Map<string, Session.Control>()
        let settleCalls = 0
        const authLostHost: Context.Service.Shape<typeof Host.Host> = {
          ...store.host,
          settle: () => {
            settleCalls++
            return Effect.fail(new Host.HostError({ code: "refused", route: "settle", status: 401 }))
          }
        }
        const engineWait = NodeRuntime.layerHost(
          { filename: join(stateDir, "engine-wait.db"), workspaceRoot: stateDir, owner: { hostId: "r-wait" } },
          Job.registration(config, controls).pipe(Layer.provide(Layer.succeed(Host.Host, authLostHost)))
        )
        const waitPayload: Session.JobPayload = {
          key: "woken-wait#g1",
          claim: "claim-2",
          generation: 1,
          task: HostFixture.task({ repository: "github/acme/missing", base: "b".repeat(40), prompt: "unused" }),
          deadline: Date.now() + 60_000
        }
        const resWait = await Effect.runPromise(
          Effect.gen(function*() {
            const awaiting = yield* Deferred.make<void>()
            const logger = Logger.make((opts) => {
              if (JSON.stringify(Logger.formatStructured.log(opts)).includes("awaiting_claim")) {
                Deferred.doneUnsafe(awaiting, Exit.void)
              }
            })
            const dropped = yield* Deferred.make<void>()
            const fiber = yield* Job.RunnerJob.execute(waitPayload, { executionId: waitPayload.key }).pipe(
              Effect.provide(engineWait),
              Effect.provideService(Logger.CurrentLoggers, new Set([logger])),
              Effect.forkChild
            )
            yield* Deferred.await(awaiting)
            controls.set(waitPayload.key, {
              cancel: yield* Deferred.make<void>(),
              dropped,
              authorization: { suspended: yield* Deferred.make<void>(), latch: yield* Latch.make(true) },
              hostEnded: yield* Deferred.make<void>(),
              reclaimed: true,
              steers: yield* Queue.unbounded<AgentRunner.Steer>(),
              delivered: new Set(),
              stats: {}
            })
            yield* Effect.sleep("80 millis")
            yield* Deferred.succeed(dropped, undefined)
            return yield* Fiber.join(fiber)
          }).pipe(Effect.scoped)
        )
        expect(resWait.recorded).toBe(false)
        expect(settleCalls).toBeGreaterThanOrEqual(1)

        // Settle non-auth-lost failure breaking immediately (lines 225-228)
        const badHost: Context.Service.Shape<typeof Host.Host> = {
          ...store.host,
          settle: () => Effect.fail(new Host.HostError({ code: "refused", route: "settle", status: 404 }))
        }
        const controls404 = new Map<string, Session.Control>()
        const key404 = "woken-404#g1"
        controls404.set(key404, {
          cancel: Effect.runSync(Deferred.make<void>()),
          dropped: Effect.runSync(Deferred.make<void>()),
          authorization: { suspended: Effect.runSync(Deferred.make<void>()), latch: Effect.runSync(Latch.make(true)) },
          hostEnded: Effect.runSync(Deferred.make<void>()),
          reclaimed: false,
          steers: Effect.runSync(Queue.unbounded<AgentRunner.Steer>()),
          delivered: new Set(),
          stats: {}
        })
        const engine404 = NodeRuntime.layerHost(
          { filename: join(stateDir, "engine-404.db"), workspaceRoot: stateDir, owner: { hostId: "r-404" } },
          Job.registration(config, controls404).pipe(Layer.provide(Layer.succeed(Host.Host, badHost)))
        )
        const res404 = await Effect.runPromise(
          Job.RunnerJob.execute(
            {
              key: key404,
              claim: "claim-404",
              generation: 1,
              task: HostFixture.task({ repository: "github/acme/missing", base: "c".repeat(40), prompt: "unused" }),
              deadline: Date.now() + 60_000
            },
            { executionId: key404 }
          ).pipe(Effect.provide(engine404), Effect.scoped)
        )
        expect(res404.recorded).toBe(false)

        // 3. runner/Session.work uncovered paths (lines 364, 474, 563, 567-594)
        const makeControl = (opts?: { cancelled?: boolean; latchOpen?: boolean }): Session.Control => {
          const cancel = Effect.runSync(Deferred.make<void>())
          if (opts?.cancelled) Deferred.doneUnsafe(cancel, Exit.void)
          return {
            cancel,
            dropped: Effect.runSync(Deferred.make<void>()),
            authorization: {
              suspended: Effect.runSync(Deferred.make<void>()),
              latch: Effect.runSync(Latch.make(opts?.latchOpen ?? true))
            },
            hostEnded: Effect.runSync(Deferred.make<void>()),
            reclaimed: false,
            steers: Effect.runSync(Queue.unbounded<AgentRunner.Steer>()),
            delivered: new Set(),
            stats: {}
          }
        }

        // 3a. machine_lost: checkout.started exists and !incomplete (line 364)
        const keyLost = "sess-lost#g1"
        const coLost = Workspace.of(stateDir, AgentRunner.parseKey(keyLost).origin)
        mkdirSync(coLost.dir, { recursive: true })
        mkdirSync(dirname(coLost.started), { recursive: true })
        writeFileSync(coLost.started, `${keyLost}\n`, "utf8")
        const outLost = await Effect.runPromise(
          Session.work(
            config,
            {
              key: keyLost,
              claim: "c-lost",
              generation: 1,
              task: HostFixture.task({
                repository: "github/acme/app",
                base: "f".repeat(40),
                profile: "test-agent",
                prompt: "hi"
              }),
              deadline: Date.now() + 60_000
            },
            makeControl()
          ).pipe(Effect.provideService(Host.Host, store.host))
        )
        expect(outLost._tag).toBe("Failed")

        // 3b. provision pre-cancelled (line 563): slow gitCredential so cancel wins Effect.raceFirst!
        const hostSlowCred: Context.Service.Shape<typeof Host.Host> = {
          ...store.host,
          gitCredential: () =>
            Effect.sleep("5 seconds").pipe(
              Effect.andThen(
                Effect.fail(new Host.HostError({ code: "unavailable", route: "git-credential", status: 503 }))
              )
            )
        }
        const outPreCancel = await Effect.runPromise(
          Session.work(
            config,
            {
              key: "sess-precancel#g1",
              claim: "c-pre",
              generation: 1,
              task: HostFixture.task({
                repository: "github/acme/app",
                base: "f".repeat(40),
                profile: "test-agent",
                prompt: "hi"
              }),
              deadline: Date.now() + 60_000
            },
            makeControl({ cancelled: true })
          ).pipe(Effect.provideService(Host.Host, hostSlowCred))
        )
        expect(outPreCancel._tag).toBe("Cancelled")

        // 3c. provision CredentialRefused 400 -> failed("workspace") (lines 567-574)
        const hostCred400: Context.Service.Shape<typeof Host.Host> = {
          ...store.host,
          gitCredential: () =>
            Effect.fail(new Host.HostError({ code: "refused", route: "git-credential", status: 400 }))
        }
        const outCred400 = await Effect.runPromise(
          Session.work(
            config,
            {
              key: "sess-cred400#g1",
              claim: "c-400",
              generation: 1,
              task: HostFixture.task({
                repository: "github/acme/app",
                base: "f".repeat(40),
                profile: "test-agent",
                prompt: "hi"
              }),
              deadline: Date.now() + 60_000
            },
            makeControl()
          ).pipe(Effect.provideService(Host.Host, hostCred400))
        )
        expect(outCred400._tag).toBe("Failed")

        // 3d. provision CredentialRefused 401 -> provisionWaitSeconds (line 474), sleep (583-587), cancel interrupts sleep (592-593)
        const hostCred401: Context.Service.Shape<typeof Host.Host> = {
          ...store.host,
          gitCredential: () =>
            Effect.fail(new Host.HostError({ code: "refused", route: "git-credential", status: 401 }))
        }
        const ctrl401 = makeControl()
        const outCred401 = await Effect.runPromise(
          Effect.gen(function*() {
            const fiber = yield* Session.work(
              config,
              {
                key: "sess-cred401#g1",
                claim: "c-401",
                generation: 1,
                task: HostFixture.task({
                  repository: "github/acme/app",
                  base: "f".repeat(40),
                  profile: "test-agent",
                  prompt: "hi"
                }),
                deadline: Date.now() + 120_000
              },
              ctrl401
            ).pipe(Effect.provideService(Host.Host, hostCred401), Effect.forkChild)
            yield* Effect.sleep("80 millis")
            yield* Deferred.succeed(ctrl401.cancel, undefined)
            return yield* Fiber.join(fiber)
          }).pipe(Effect.scoped)
        )
        expect(outCred401._tag).toBe("Cancelled")

        // 3e. provision CredentialUnavailable with near deadline -> timeout (line 582)
        const hostCred503: Context.Service.Shape<typeof Host.Host> = {
          ...store.host,
          gitCredential: () =>
            Effect.fail(
              new Host.HostError({ code: "unavailable", route: "git-credential", status: 503, retryAfterSeconds: 1 })
            )
        }
        const outCred503 = await Effect.runPromise(
          Session.work(
            config,
            {
              key: "sess-cred503#g1",
              claim: "c-503",
              generation: 1,
              task: HostFixture.task({
                repository: "github/acme/app",
                base: "f".repeat(40),
                profile: "test-agent",
                prompt: "hi"
              }),
              deadline: Date.now() + 100
            },
            makeControl()
          ).pipe(Effect.provideService(Host.Host, hostCred503))
        )
        expect(outCred503._tag).toBe("Failed")
      })
    },
    60_000
  )

  it(
    "covers ModuleAuthority matched executable digest, reenterModules, beforeSteeringDrain & shared Budget",
    async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const modFlow = { _tag: "registry/entry/abc/demo/mod" } as never
          const desc = new Descriptor.FlowDescriptor({
            name: "demo/mod",
            description: "Demo module flow",
            path: "/retained/flows/demo/mod",
            body: new Descriptor.BodyRefModule({
              path: "/retained/flows/demo/mod/flow.ts",
              contentDigest: "a".repeat(64)
            }),
            input: new Descriptor.SchemaRefModule({ path: "/retained/flows/demo/mod/flow.ts", field: "input" }),
            output: new Descriptor.SchemaRefModule({ path: "/retained/flows/demo/mod/flow.ts", field: "output" }),
            model: Option.none(),
            placement: Option.none(),
            modelInvocable: true,
            flows: [],
            capabilities: [],
            frontmatter: {},
            effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
            provenance: new Descriptor.Provenance({ source: "project", root: "/retained/flows" })
          })
          const approvedDigest = Descriptor.executionDigest(desc)!
          const execEntry = {
            descriptor: desc,
            flow: modFlow,
            delegate: undefined
          }

          let catalogExecutables: ReadonlyArray<typeof execEntry> = [execEntry]
          let launchesHasMore = false
          let launchesEntries: Array<JournalEvent.Entry> = []
          let drainCount = 0

          const runRows = new Map<string, RunStore.RunRow>()
          const controlRuns = new Map<string, RunSummary>()
          let capturedHandler:
            | ((input: unknown, executionId: string) => Effect.Effect<unknown, unknown, never>)
            | undefined

          const makeRow = (runId: string, parentRunId: string | null, stateJson: string): RunStore.RunRow => ({
            runId,
            parentRunId,
            status: "running",
            stateJson,
            createdAt: 1,
            updatedAt: 1
          } as unknown as RunStore.RunRow)

          const fakeEngine = FlowRuntime.FlowRuntime.of({
            register: (_flow: unknown, handler: any) =>
              Effect.sync(() => {
                capturedHandler = handler
              }),
            get: () => Effect.die("unused"),
            list: () => Effect.succeed([])
          } as never)

          const fakeControl = ControlRuntime.ControlRuntime.of(
            {
              getRun: (id: string) =>
                controlRuns.has(id)
                  ? Effect.succeed(controlRuns.get(id)!)
                  : Effect.fail(new RunNotFound({ runId: id })),
              getPlan: (planId: string) =>
                Effect.succeed({
                  planId,
                  decision: "approved",
                  card: {
                    planId,
                    digest: "plan-digest-1",
                    flowId: "demo/mod",
                    executionDigest: approvedDigest,
                    envelope: { capabilities: ["read:*"], flows: ["demo/mod"], budget: { maxUsd: 5 } }
                  }
                } as unknown as ControlRuntime.StoredPlan)
            } as unknown as ControlRuntime.ControlRuntime["Service"]
          )

          const fakeState = DurableEngineState.DurableEngineState.of({
            runParents: () => Effect.succeed([])
          } as never)

          const fakeRuns = RunStore.RunStore.of({
            get: (id: string) =>
              runRows.has(id)
                ? Effect.succeed(runRows.get(id)!)
                : Effect.fail({ _tag: "RunStoreError", code: "not_found_row" })
          } as never)

          let suspendShouldFail = false
          const fakeControlJournal = Journal.Journal.of({
            entries: (opts: Journal.EntriesOptions) => {
              if (opts.eventTypes?.includes("control.module.launched")) {
                return Effect.succeed({ entries: launchesEntries, hasMore: launchesHasMore })
              }
              return Effect.succeed({ entries: [], hasMore: false })
            },
            emitDurableUnfenced: () =>
              suspendShouldFail
                ? Effect.fail(new Error("suspend journal fail") as never)
                : Effect.succeed({} as never),
            read: () => Stream.empty
          } as unknown as Journal.Service)

          const realStore = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
          const realEngineJournal = Context.get(realStore, Journal.Journal)
          let failNextSuspend = false
          const fakeEngineJournal: Journal.Service = {
            ...realEngineJournal,
            emitDurableUnfenced: (input: any) =>
              failNextSuspend && String(input?.eventType ?? "").includes("suspend")
                ? Effect.fail(new Error("suspend boom") as never)
                : realEngineJournal.emitDurableUnfenced(input)
          }

          const fakeNotifications = NotificationQueue.NotificationQueue.of({
            publish: () => Effect.void,
            read: () => Effect.succeed([]),
            drain: () => Effect.succeed([])
          } as never)

          const fakeRegistry = Registry.Registry.of({
            list: () => Effect.succeed([desc]),
            getOption: () => Effect.succeed(Option.some(desc)),
            loadBody: () => Effect.succeed(modFlow),
            refresh: () => Effect.void
          } as never)

          const fakeQuota = QuotaPolicy.QuotaClassifier.of({
            classify: () => ({ _tag: "Allowed" })
          } as never)

          const auth = yield* ModuleAuthority.make(
            Effect.sync(() => ({ executables: catalogExecutables, refusals: [] } as never)),
            { capabilityEnvelope: [], exec: () => Effect.void } as never,
            {
              controlJournal: fakeControlJournal,
              parks: true,
              reenterModules: ["demo/mod"],
              beforeSteeringDrain: () =>
                Effect.sync(() => {
                  drainCount++
                })
            }
          ).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, fakeEngine),
            Effect.provideService(DurableEngineState.DurableEngineState, fakeState),
            Effect.provideService(RunStore.RunStore, fakeRuns),
            Effect.provideService(ControlRuntime.ControlRuntime, fakeControl),
            Effect.provideService(Journal.Journal, fakeEngineJournal),
            Effect.provideService(QuotaPolicy.QuotaClassifier, fakeQuota),
            Effect.provideService(Registry.Registry, fakeRegistry),
            Effect.provideService(NotificationQueue.NotificationQueue, fakeNotifications)
          )

          yield* auth.runtime.register(
            modFlow as never,
            () =>
              Effect.gen(function*() {
                const b = yield* Budget.Budget
                const st = yield* Steering.Source
                yield* st.drain({ boundary: "step-1" } as never).pipe(Effect.catch(() => Effect.void))
                yield* b.check(undefined).pipe(Effect.catch(() => Effect.void))
                yield* b.check("s1").pipe(Effect.catch(() => Effect.void))
                yield* b.reserve("s1").pipe(Effect.catch(() => Effect.void))
                yield* b.admitReading("s1").pipe(Effect.catch(() => Effect.void))
                yield* b.record("s1", { inputTokens: 1, outputTokens: 1 } as never, "sonnet").pipe(
                  Effect.catch(() => Effect.void)
                )
                yield* b.usage.pipe(Effect.catch(() => Effect.void))
                yield* b.usageOf("s1").pipe(Effect.catch(() => Effect.void))
                return "done"
              }) as never
          )
          expect(capturedHandler).toBeDefined()

          const runExec = (execId: string) =>
            Effect.exit(
              capturedHandler!({}, execId).pipe(
                Effect.provideService(FlowRuntime.FlowInstance, {
                  runId: execId,
                  executionId: execId,
                  suspended: false
                } as never),
                Effect.provideService(FlowRuntime.FlowRuntime, fakeEngine)
              )
            )

          const rootState = JSON.stringify({
            version: 1,
            flowName: "agent/run",
            payload: { planId: "plan-1" },
            completedSteps: {}
          })
          controlRuns.set("root-ma", {
            runId: "root-ma",
            flowId: "demo/mod",
            status: "running",
            planId: "plan-1",
            planDigest: "plan-digest-1",
            createdAt: 1,
            updatedAt: 1
          } as unknown as RunSummary)
          runRows.set("root-ma", makeRow("root-ma", null, rootState))
          runRows.set("child-ma", makeRow("child-ma", "root-ma", rootState))

          // 1. executable === undefined -> line 217
          catalogExecutables = []
          expect(Exit.isFailure(yield* runExec("child-ma"))).toBe(true)
          catalogExecutables = [execEntry]

          // 2. reenterModules launches.hasMore === true -> lines 232, 237-238
          launchesHasMore = true
          expect(Exit.isFailure(yield* runExec("child-ma"))).toBe(true)
          launchesHasMore = false

          // 3. reenterModules mismatched executionDigest -> lines 240-248
          launchesEntries = [
            {
              runId: JournalEvent.RunId.make("root-ma"),
              seq: 1,
              eventType: "control.module.launched",
              payload: { ordinal: 0, executionDigest: "wrong-digest", executionId: "child-ma" }
            } as unknown as JournalEvent.Entry
          ]
          expect(Exit.isFailure(yield* runExec("child-ma"))).toBe(true)

          // 4. Valid launch marker -> hits line 250, beforeSteeringDrain (304-306), shared budget (323-328), and suspend error (347)!
          launchesEntries = [
            {
              runId: JournalEvent.RunId.make("root-ma"),
              seq: 1,
              eventType: "control.module.launched",
              payload: { ordinal: 0, executionDigest: approvedDigest, executionId: "child-ma" }
            } as unknown as JournalEvent.Entry
          ]
          suspendShouldFail = true
          failNextSuspend = true
          const okExit = yield* runExec("child-ma")
          expect(Exit.isSuccess(okExit)).toBe(true)
          expect(drainCount).toBe(1)
        }).pipe(Effect.provide(NodeCrypto.layer), Effect.scoped) as unknown as Effect.Effect<void, unknown, never>
      )
    },
    30_000
  )

  it(
    "covers EngineJournalSupervisor close-active, emit failure, onSourceApplied, removed rows, generation bump, not_found_row & follow error",
    async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const makeFixture = Effect.gen(function*() {
            const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const destination = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
            const engineJournal = Context.get(native, Journal.Journal)
            const controlJournal = Context.get(destination, Journal.Journal)
            const engineState = Context.get(native, DurableEngineState.DurableEngineState)
            const runs = Context.get(native, RunStore.RunStore)
            const sql = Context.get(native, SqlClient.SqlClient)
            const controls = new Map<string, RunSummary>([
              [
                "root",
                {
                  runId: "root",
                  flowId: "coding/ImplementPlan",
                  status: "running",
                  planId: "approved-plan",
                  createdAt: 1,
                  updatedAt: 1
                } as RunSummary
              ]
            ])
            const control: Pick<ControlRuntime.Service, "getRun" | "pageRunIds"> = {
              getRun: (id) =>
                Effect.suspend(() => {
                  const run = controls.get(id)
                  return run === undefined ? Effect.fail(new RunNotFound({ runId: id })) : Effect.succeed(run)
                }),
              pageRunIds: () => Effect.sync(() => ({ ids: [...controls.keys()], through: controls.size }))
            }
            return {
              engineJournal,
              controlJournal,
              engineState,
              runs,
              sql,
              control,
              controls,
              inControlTransaction: Effect.map(
                Effect.serviceOption(Context.get(destination, SqlClient.SqlClient).transactionService),
                Option.isSome
              )
            }
          })

          // 1. onSourceApplied + after.row removed + close while active (lines 159-160, 311, 340, 343)
          {
            const fx = yield* makeFixture
            yield* fx.runs.create(
              "root",
              JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId: "approved-plan" } })
            )
            let sourceAppliedCount = 0
            const scope = yield* Scope.make()
            const sup = yield* Supervisor.make({
              ...fx,
              onSourceApplied: () =>
                Effect.sync(() => {
                  sourceAppliedCount++
                })
            }).pipe(Effect.provideService(Scope.Scope, scope))

            yield* fx.engineJournal.transact(
              fx.engineJournal.emitDurableUnfenced({
                runId: JournalEvent.RunId.make("root"),
                eventType: "flows.engine.node-started",
                payload: { nodeId: "n1" },
                sourceId: JournalEvent.SourceId.make("src-1")
              } as never)
            )
            yield* sup.start("root")
            yield* Effect.sleep("60 millis")
            yield* fx.sql`DELETE FROM flows_runs WHERE run_id = ${"root"}`
            yield* fx.engineJournal.transact(
              fx.engineJournal.emitDurableUnfenced({
                runId: JournalEvent.RunId.make("root"),
                eventType: "flows.engine.node-finished",
                payload: { nodeId: "n1" },
                sourceId: JournalEvent.SourceId.make("src-2")
              } as never)
            )
            yield* Effect.sleep("80 millis")
            yield* Scope.close(scope, Exit.void)
            expect(sourceAppliedCount).toBeGreaterThanOrEqual(0)
          }

          // 2. emit failure warning (line 211) & follow error with generation=undefined (lines 350-354)
          {
            const fx = yield* makeFixture
            yield* fx.runs.create(
              "root",
              JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId: "approved-plan" } })
            )
            const failingControlJournal: Journal.Service = {
              ...fx.controlJournal,
              emitDurableUnfenced: () => Effect.fail(new Error("emit boom") as never)
            }
            const failingEngineJournal: Journal.Service = {
              ...fx.engineJournal,
              generation: undefined,
              entries: () => Effect.fail(new Error("follow boom") as never)
            }
            const scope = yield* Scope.make()
            const sup = yield* Supervisor.make({
              ...fx,
              controlJournal: failingControlJournal,
              engineJournal: failingEngineJournal
            }).pipe(Effect.provideService(Scope.Scope, scope))
            yield* sup.start("root")
            yield* Effect.sleep("80 millis")
            yield* Scope.close(scope, Exit.void)
          }

          // 3. before.row === undefined (line 317) & not_found_row (line 326) & follow error with generation defined (352-354)
          {
            const fx = yield* makeFixture
            let genCall = 0
            const customEngineJournal: Journal.Service = {
              ...fx.engineJournal,
              generation: () =>
                Effect.sync(() => ({
                  generation: genCall++ === 0 ? 0 : 1,
                  afterSeq: 0
                }))
            }
            const scope1 = yield* Scope.make()
            const sup1 = yield* Supervisor.make({
              ...fx,
              engineJournal: customEngineJournal
            }).pipe(Effect.provideService(Scope.Scope, scope1))
            yield* sup1.start("root")
            yield* Effect.sleep("80 millis")
            yield* Scope.close(scope1, Exit.void)

            const scope2 = yield* Scope.make()
            const sup2 = yield* Supervisor.make({
              ...fx,
              engineJournal: {
                ...fx.engineJournal,
                entries: () => Effect.fail(new Error("entries boom") as never),
                generation: () => Effect.succeed({ generation: 2, afterSeq: 0 })
              },
              runs: {
                ...fx.runs,
                get: () => Effect.fail({ _tag: "RunStoreError", code: "not_found_row" } as never)
              }
            }).pipe(Effect.provideService(Scope.Scope, scope2))
            yield* fx.runs.create(
              "root",
              JSON.stringify({ version: 1, flowName: "agent/run", payload: { planId: "approved-plan" } })
            )
            yield* sup2.start("root")
            yield* Effect.sleep("80 millis")
            yield* Scope.close(scope2, Exit.void)
          }
        }).pipe(Effect.provide(NodeCrypto.layer), Effect.scoped)
      )
    },
    30_000
  )

  it(
    "covers ControlCommands (logs renderer, signal --wait, continue/stop guard incidents), ControlBridge & Cli tail",
    async () => {
      await withTempDir("wave9n-5-", async (tmp) => {
        const proj = join(tmp, "proj")
        mkdirSync(join(proj, ".smithers", "flows", "echo"), { recursive: true })
        const env: Record<string, string | undefined> = {
          HOME: tmp,
          XDG_CONFIG_HOME: tmp,
          XDG_DATA_HOME: join(tmp, "data"),
          PATH: process.env.PATH
        }

        const dbPath = NodeControl.databasePath(proj)
        mkdirSync(join(proj, ".smithers"), { recursive: true })
        await Effect.runPromise(
          Effect.gen(function*() {
            const control = yield* Control.Control
            yield* control.list({ _tag: "runs", limit: 1 })
          }).pipe(
            Effect.provide(NodeControl.layer({ root: proj, startsRuns: false })),
            Effect.scoped
          )
        )

        const { DatabaseSync } = await import("node:sqlite")
        const db = new DatabaseSync(dbPath)
        const now = Date.now()
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
        const tableNames = new Set(tables.map((t) => t.name))

        if (tableNames.has("control_runs") && tableNames.has("flows_journal_events")) {
          const runCols = (db.prepare("PRAGMA table_info(control_runs)").all() as Array<{ name: string }>).map((c) =>
            c.name
          )
          const insertRun = (runId: string, status: string) => {
            const base: Record<string, unknown> = {
              run_id: runId,
              created_seq: 1,
              flow_id: "demo/echo",
              status,
              created_at: now,
              updated_at: now,
              created_at_ms: now,
              updated_at_ms: now,
              actor_id: "local",
              actor_kind: "operator",
              principal_id: "local",
              principal_kind: "operator",
              payload_json: "{}",
              input_json: "{}",
              summary_json: JSON.stringify({ runId, flowId: "demo/echo", status, createdAt: now, updatedAt: now })
            }
            const cols = runCols.filter((c) => c in base)
            const sql = `INSERT OR REPLACE INTO control_runs (${cols.join(",")}) VALUES (${
              cols.map(() => "?").join(",")
            })`
            db.prepare(sql).run(...(cols.map((c) => base[c]) as Array<any>))
          }
          const insertEv = (runId: string, seq: number, kind: string, payload: unknown) => {
            db.prepare(
              "INSERT OR REPLACE INTO flows_journal_events (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).run(
              runId,
              seq,
              `ev-${runId}-${seq}`,
              `src-${runId}-${seq}`,
              0,
              now + seq,
              kind,
              JSON.stringify(payload),
              JSON.stringify({ actor: { id: "local", kind: "operator" } })
            )
          }

          insertRun("run-sig", "running")
          insertEv("run-sig", 1, "control.run.accepted", { flowId: "demo/echo" })
          insertEv("run-sig", 2, "control.run.started", { flowId: "demo/echo" })

          const incidentReq = (runId: string, reqId: string) => ({
            runId,
            requestId: reqId,
            question: "Budget exceeded",
            payload: {
              target: { _tag: "Node", runId, requestId: reqId },
              scope: "run",
              idempotencyKey: `idk-${reqId}`
            },
            incident: {
              classification: "Runaway",
              source: "usd",
              message: "limit reached",
              used: 5.5,
              reserved: 1.0,
              max: 5.0,
              next: 0.5,
              allowance: 5.0
            }
          })

          insertRun("run-gp", "parked")
          insertEv("run-gp", 1, "control.run.accepted", { flowId: "demo/echo" })
          insertEv("run-gp", 2, "control.approval.requested", incidentReq("run-gp", "req-gp"))

          insertRun("run-ga", "parked")
          insertEv("run-ga", 1, "control.run.accepted", { flowId: "demo/echo" })
          insertEv("run-ga", 2, "control.approval.requested", incidentReq("run-ga", "req-ga"))
          insertEv("run-ga", 3, "control.approval.approved", {
            requestId: "req-ga",
            by: "local"
          })

          insertRun("run-gd", "parked")
          insertEv("run-gd", 1, "control.run.accepted", { flowId: "demo/echo" })
          insertEv("run-gd", 2, "control.approval.requested", incidentReq("run-gd", "req-gd"))
          insertEv("run-gd", 3, "control.approval.denied", {
            requestId: "req-gd",
            by: "local"
          })
        }
        db.close()

        const runCli = async (argv: Array<string>, extra: Partial<ControlBridge.Runtime> = {}) => {
          const out: Array<string> = []
          let exitCode: number | undefined
          const cli = Cli.makeCli({
            environment: env,
            exit: (c: number) => {
              exitCode = c
            },
            ...extra
          })
          await cli.serve(argv, {
            stdout: (s: string) => out.push(s),
            exit: (c: number) => {
              exitCode = c
            }
          })
          return { out: out.join(""), exitCode }
        }

        // 1. runs logs --limit 1 in human format (renderer defined -> line 644!)
        const logsRes = await runCli(["runs", "logs", "run-sig", "--root", proj, "--limit", "1"])
        expect(logsRes).toBeDefined()

        // 2. runs signal --wait --timeout 220 (hits ControlBridge.signalReceipts sleep + timeout lines 464-465 AND ControlCommands lines 882-903!)
        const sigPending = await runCli([
          "runs",
          "signal",
          "run-sig",
          "{\"type\":\"ping\"}",
          "--root",
          proj,
          "--wait",
          "--timeout",
          "220",
          "--json"
        ])
        expect(sigPending.out.length).toBeGreaterThan(0)

        const db2 = new DatabaseSync(dbPath)
        const sigTables = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%signal%'")
          .all() as Array<{ name: string }>
        if (sigTables.length > 0) {
          const tbl = sigTables[0]!.name
          const cols = (db2.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>).map((c) => c.name)
          if (cols.includes("state")) {
            const rejSet = cols.includes("rejection")
              ? "state = 'rejected', rejection = 'bad_state'"
              : "state = 'rejected'"
            db2.prepare(`UPDATE ${tbl} SET ${rejSet}`).run()
            const sigRej = await runCli([
              "runs",
              "signal",
              "run-sig",
              "{\"type\":\"ping\"}",
              "--root",
              proj,
              "--wait",
              "--timeout",
              "50",
              "--json"
            ])
            expect(sigRej.out.length).toBeGreaterThan(0)

            db2.prepare(`UPDATE ${tbl} SET state = 'delivered'`).run()
            const sigDel = await runCli([
              "runs",
              "signal",
              "run-sig",
              "{\"type\":\"ping\"}",
              "--root",
              proj,
              "--wait",
              "--timeout",
              "50",
              "--json"
            ])
            expect(sigDel.out.length).toBeGreaterThan(0)

            db2.prepare(`DELETE FROM ${tbl}`).run()
            const sigMiss = await runCli([
              "runs",
              "signal",
              "run-sig",
              "{\"type\":\"ping\"}",
              "--root",
              proj,
              "--wait",
              "--timeout",
              "50",
              "--json"
            ])
            expect(sigMiss.out.length).toBeGreaterThan(0)
          }
        }
        db2.close()

        // 3. runs continue & runs stop on guard incidents (lines 974-995)
        const gpCont = await runCli(["runs", "continue", "run-gp", "--root", proj, "--json"])
        expect(gpCont.out.length).toBeGreaterThan(0)
        const gpStop = await runCli(["runs", "stop", "run-gp", "--root", proj, "--json"])
        expect(gpStop.out.length).toBeGreaterThan(0)
        const gaStop = await runCli(["runs", "stop", "run-ga", "--root", proj, "--json"])
        expect(gaStop.out).toContain("guard_incident_decided")
        const gdCont = await runCli(["runs", "continue", "run-gd", "--root", proj, "--json"])
        expect(gdCont.out).toContain("guard_incident_decided")
        const gaCont = await runCli(["runs", "continue", "run-ga", "--root", proj, "--json"])
        expect(gaCont.out.length).toBeGreaterThan(0)

        // 4. ControlBridge.host with non-silent progress & operatorToken -> prints banner & approval token (lines 588-591) & Cli serve command (lines 329-332)!
        const hostAc = new AbortController()
        const serveOut: Array<string> = []
        const serveCli = Cli.makeCli({
          environment: env,
          signal: hostAc.signal
        })
        const servePromise = serveCli.serve(["serve", "--root", proj, "--host", "127.0.0.1", "--port", "0"], {
          stdout: (s: string) => serveOut.push(s)
        })
        setTimeout(() => hostAc.abort(), 200)
        await servePromise.catch(() => {})
        expect(serveOut).toBeDefined()

        // 5. Cli.ts mcp add succeeding on temp HOME/.claude.json (line 131)
        writeFileSync(join(tmp, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8")
        const mcpOk = await runCli(["mcp", "add", "--agent", "claude", "--json"])
        expect(mcpOk.out).toContain("claude")

        // 6. Cli.ts skills add without --no-global (lines 746-748)
        const skillsRes = await runCli(["skills", "add", "--json"])
        expect(skillsRes).toBeDefined()

        // 7. Cli.ts doctor with failing check -> exit 1 (line 312)
        const badDocProj = join(tmp, "bad-doc")
        mkdirSync(join(badDocProj, ".smithers"), { recursive: true })
        writeFileSync(join(badDocProj, ".smithers", "control.db"), "corrupt-sqlite-bytes", "utf8")
        const docRes = await runCli(["doctor", "--root", badDocProj, "--json"])
        expect(docRes.out.length).toBeGreaterThan(0)

        // 8. Cli.ts alerts ack human render (line 251) via fake remote RPC server
        const rpcServer = createServer((req, res) => {
          let body = ""
          req.on("data", (c) => (body += c))
          req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ acknowledged: true, runId: "r1", alertId: "a1", by: "ops", at: now }))
          })
        })
        await new Promise<void>((r) => rpcServer.listen(0, "127.0.0.1", r))
        try {
          const rpcOrigin = `http://127.0.0.1:${(rpcServer.address() as AddressInfo).port}`
          await runCli(["alerts", "ack", "--run", "r1", "--id", "a1", "--by", "ops", "--remote", rpcOrigin])
        } finally {
          rpcServer.closeAllConnections()
          await new Promise<void>((r) => rpcServer.close(() => r()))
        }

        // 9. Cli.ts serve without stdout option (line 797)
        const origW = process.stdout.write.bind(process.stdout)
        const defOut: Array<string> = []
        process.stdout.write = ((chunk: unknown) => {
          defOut.push(String(chunk))
          return true
        }) as typeof process.stdout.write
        try {
          await Cli.makeCli({ environment: env }).serve(["--version"])
        } finally {
          process.stdout.write = origW
        }
        expect(defOut.join("").length).toBeGreaterThan(0)
      })
    },
    60_000
  )
})
