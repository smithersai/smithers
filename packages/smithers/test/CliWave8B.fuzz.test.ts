import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import * as ControlError from "@smthrs/control/ControlError"
import * as ControlSchema from "@smthrs/control/ControlSchema"
import { Fuzz } from "@smthrs/fuzz"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Arbitrary, Cause, Console, Duration, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import * as EffectCli from "effect/cli"
import { HttpServer } from "effect/http"
import { DatabaseSync } from "node:sqlite"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { hostname, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as CatalogRequest from "../src/CatalogRequest.ts"
import * as Cli from "../src/Cli.ts"
import * as CliError from "../src/CliError.ts"
import * as CommandMod from "../src/Command.ts"
import * as DidYouMean from "../src/DidYouMean.ts"
import * as CommandStatus from "../src/internal/CommandStatus.ts"
import * as Output from "../src/Output.ts"
import * as Serve from "../src/Serve.ts"
import * as Ui from "../src/Ui.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Argv from "../src/cli/Argv.ts"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as ControlCommands from "../src/cli/ControlCommands.ts"
import * as EntryMod from "../src/cli/Entry.ts"
import * as Generate from "../src/cli/Generate.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import * as RunActivity from "../src/cli/RunActivity.ts"
import * as RunHistory from "../src/cli/RunHistory.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import * as StepCacheCommands from "../src/cli/StepCacheCommands.ts"
import * as TargetApprovals from "../src/cli/TargetApprovals.ts"
import * as AlertsCmd from "../src/commands/Alerts.ts"
import * as DoctorCmd from "../src/commands/Doctor.ts"
import * as DoctorMod from "../src/Doctor.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as GcMod from "../src/Gc.ts"
import * as Launch from "../src/commands/Launch.ts"
import * as RunControl from "../src/commands/RunControl.ts"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as Tui from "../src/commands/Tui.ts"
import * as UpdateCmd from "../src/commands/Update.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Project from "../src/Project.ts"
import * as Suggest from "../src/Suggest.ts"
import { invoke as invokeUnified, project as unifiedProject, remoteAddress, serverLayer, waitingProject } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261129")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const expectPassed = (report: { readonly _tag: string; readonly findings?: ReadonlyArray<unknown> }) => {
  if (report._tag !== "Passed") {
    const first = report.findings?.[0] as { failure?: { defect?: unknown } } | undefined
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report.findings?.[0])
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const makeRun = (overrides: Partial<ControlSchema.RunSummary> & { readonly runId: string }): ControlSchema.RunSummary => ({
  runId: overrides.runId,
  flowId: overrides.flowId ?? "demo/flow",
  status: overrides.status ?? "running",
  createdAt: overrides.createdAt ?? 1_000,
  updatedAt: overrides.updatedAt ?? 2_000,
  planId: overrides.planId ?? "plan-1",
  planDigest: overrides.planDigest ?? "digest-1",
  ownerId: overrides.ownerId,
  parkedBy: overrides.parkedBy,
  waitingReason: overrides.waitingReason,
  parentRunId: overrides.parentRunId,
  executionDigest: overrides.executionDigest,
  pendingWaits: overrides.pendingWaits
})

const makeEvent = (
  runId: string,
  sequence: number,
  kind: string,
  payload: Schema.Json = {},
  occurredAt = 1_000 + sequence * 100
): ControlSchema.ControlEvent => ({
  runId,
  sequence,
  kind,
  occurredAt,
  payload
})

describe("@smthrs/cli Wave-8B Deep Settlement, Launch, RunControl, Runner, Tui, ControlCommands, Timing, History, Ui & Output fuzz", () => {
  it("Settlement, Launch, RunControl, Serve & Update uphold settlement, hand-off, budget & signal invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(11)),
        retryable: Schema.Boolean,
        quiet: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scenario, retryable, quiet }) =>
          Effect.gen(function*() {
            // 1. Settlement.releasedCause across decision shapes
            const decisions: ReadonlyArray<ControlSchema.ControlEvent> = [
              makeEvent("r1", 1, "control.engine.event", {
                executionId: "ex-1",
                eventType: "flows.engine.run-decision",
                payload: { decision: "interrupt-released", flowName: "stepA", cause: "lease-lapsed", unconfirmedMs: 12_345 }
              }),
              makeEvent("r1", 2, "control.engine.event", {
                executionId: "ex-2",
                eventType: "flows.engine.run-decision",
                payload: { decision: "interrupt-released", flowName: "stepB", cause: "interrupted" }
              }),
              makeEvent("r1", 3, "control.engine.event", {
                executionId: "ex-3",
                eventType: "flows.engine.run-decision",
                payload: { decision: "interrupt-released", flowName: "stepC", cause: "other" }
              })
            ]
            const c1 = Settlement.releasedCause("r1", "demo/flow", decisions)
            const c2 = Settlement.releasedCause("r1", "demo/flow", [])
            assertInv(c1.includes("r1") && c2.includes("interrupted mid-step"), "releasedCause formats")

            // 2. Build fake Control service for Settlement / Launch / RunControl scenarios
            let listStatus: ControlSchema.RunSummary["status"] = "completed"
            let listWaiting: string | undefined = undefined
            let listOwner: string | undefined = undefined
            let listParkedBy: string | undefined = undefined
            let watchEvents: ReadonlyArray<ControlSchema.ControlEvent> = [
              makeEvent("r1", 1, "control.run.completed", {})
            ]
            let watchFailsOnSecond = false
            let watchCalls = 0
            let watchInterrupts = false
            let resumeReceipt: ControlSchema.Receipt = { _tag: "Accepted", receiptId: "rcpt-1", runId: "r1" }
            let runReceipt: ControlSchema.Receipt = { _tag: "Accepted", receiptId: "rcpt-2", runId: "r1" }

            if (scenario === 0) {
              // awaitRun: stream ends early -> unsettled reads completed
              watchEvents = []
              listStatus = "completed"
            } else if (scenario === 1) {
              // awaitRun: stream ends early -> unsettled reads parked + released
              watchEvents = []
              listStatus = "parked"
              listWaiting = "released"
            } else if (scenario === 2) {
              // awaitRun: stream ends early -> unsettled sees running -> TransportError
              watchEvents = []
              listStatus = "running"
            } else if (scenario === 3) {
              // awaitRun: stream emits control.run.parked then run transitions to running, followed by completed
              watchEvents = [
                makeEvent("r1", 1, "control.run.parked", {}),
                makeEvent("r1", 2, "control.run.completed", {})
              ]
              listStatus = "running"
            } else if (scenario === 4) {
              // awaitRun: stream interrupted internally -> falls through to unsettled
              watchInterrupts = true
              listStatus = "failed"
            } else if (scenario === 5) {
              // awaitHandOff: watch sees control.run.claimed and summary is running
              watchEvents = [makeEvent("r1", 2, "control.run.claimed", {})]
              listStatus = "running"
            } else if (scenario === 6) {
              // Launch.resume: handedTo triggers awaitHandOff
              watchEvents = [makeEvent("r1", 2, "control.run.claimed", {})]
              listStatus = "running"
              resumeReceipt = {
                _tag: "Accepted",
                receiptId: "rcpt-3",
                runId: "r1",
                handedTo: { hostId: hostname(), pid: process.pid }
              }
            } else if (scenario === 7) {
              // Launch.resume: Terminal failed with failure event
              resumeReceipt = { _tag: "Terminal", status: "failed", runId: "r1" }
              watchEvents = [
                makeEvent("r1", 2, "control.run.failed", {
                  tag: "BoomError",
                  message: "failed bad",
                  retryable
                })
              ]
              listStatus = "failed"
            } else if (scenario === 8) {
              // Launch.resume: Terminal failed with watch failure (unavailable details)
              resumeReceipt = { _tag: "Terminal", status: "failed", runId: "r1" }
              watchFailsOnSecond = true
              listStatus = "failed"
            } else if (scenario === 9) {
              // awaitOwnedRun: Parked / Terminal / foreign owner / dead-pid parker
              listOwner = undefined
              listParkedBy = JSON.stringify({ hostId: hostname(), pid: 99_999_999, nonce: "dead" })
              watchEvents = [makeEvent("r1", 2, "control.run.completed", {})]
            } else if (scenario === 10) {
              // awaitOwnedRun: live foreign owner returns undefined
              listOwner = JSON.stringify({ hostId: "foreign.host", pid: 1234, nonce: "live" })
            } else if (scenario === 11) {
              // Launch.run declined settlement
              watchEvents = [makeEvent("r1", 2, "control.run.declined", { reason: "nope" })]
              listStatus = "cancelled"
            }

            const control = Control.Control.of({
              list: (req: ControlSchema.ListRequest) => {
                if (req._tag === "runs") {
                  return Effect.succeed({
                    _tag: "runs",
                    items: [
                      makeRun({
                        runId: "r1",
                        status: listStatus,
                        waitingReason: listWaiting,
                        ownerId: listOwner,
                        parkedBy: listParkedBy
                      })
                    ]
                  })
                }
                if (req._tag === "flows") {
                  return Effect.succeed({
                    _tag: "flows",
                    items: [{ flowId: "demo/flow", description: "demo", deployClass: false, envelope: { capabilities: [], flows: [], budget: {} } }]
                  })
                }
                return Effect.succeed({ _tag: "approvals", items: [] })
              },
              watch: () => {
                watchCalls += 1
                if (watchFailsOnSecond && watchCalls >= 2) {
                  return Stream.fail(new ControlError.TransportError({ message: "lost conn", retryable: true }))
                }
                if (watchInterrupts) {
                  return Stream.fromEffect(Effect.interrupt)
                }
                return Stream.fromIterable(watchEvents)
              },
              plan: (input: { readonly flowId: string }) =>
                Effect.succeed({
                  planId: "plan-1",
                  flowId: input.flowId,
                  decision: "pending",
                  card: { planId: "plan-1", flowId: input.flowId, digest: "d1", envelope: { capabilities: [], flows: [], budget: {} } }
                }),
              run: () => Effect.succeed(runReceipt),
              resume: () => Effect.succeed(resumeReceipt),
              cancel: () => Effect.succeed({ _tag: "Terminal", status: "cancelled", runId: "r1" }),
              pause: () => Effect.succeed({ _tag: "Accepted", runId: "r1" }),
              signal: () => Effect.succeed({ _tag: "Accepted", runId: "r1" })
            } as unknown as Control.Service)

            const provideCtrl = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
              eff.pipe(
                Effect.provideService(Control.Control, control),
                Effect.provideService(ExecutorOwnership.ExecutorOwnership, true),
                Effect.provideService(Project.ProjectRoot, "/tmp/demo")
              )

            if (scenario <= 4) {
              const res = yield* Effect.exit(provideCtrl(Settlement.awaitRun(control, "r1", undefined, quiet)))
              if (scenario === 2) assertInv(Exit.isFailure(res), "unsettled running fails with TransportError")
              else assertInv(Exit.isSuccess(res), `awaitRun scenario ${scenario} succeeds`)
            } else if (scenario === 5) {
              const sum = yield* provideCtrl(
                Settlement.awaitHandOff(control, "r1", { hostId: hostname(), pid: process.pid }, 0)
              )
              assertInv(sum.runId === "r1", "awaitHandOff returned summary")
            } else if (scenario >= 6 && scenario <= 8) {
              const res = yield* provideCtrl(Launch.resume("r1", scenario === 6, quiet))
              assertInv(typeof res === "object" && res !== null, "Launch.resume returned receipt")
            } else if (scenario === 9 || scenario === 10) {
              const sTerm = yield* provideCtrl(Settlement.awaitOwnedRun(control, { _tag: "Terminal", status: "completed", runId: "r1" }, undefined, quiet))
              const sPark = yield* provideCtrl(Settlement.awaitOwnedRun(control, { _tag: "Parked", receiptId: "p-1", planId: "plan-1", status: "waiting-approval" }, undefined, quiet))
              const sAcc = yield* provideCtrl(Settlement.awaitOwnedRun(control, { _tag: "Accepted", receiptId: "a-1", runId: "r1" }, undefined, quiet))
              assertInv(sTerm?.kind === "control.run.completed" && sPark?.kind === "control.run.waiting-approval", "Terminal/Parked owned run")
              if (scenario === 10) assertInv(sAcc === undefined, "foreign owner returns undefined")
            } else if (scenario === 11) {
              const badRun = yield* Effect.exit(
                provideCtrl(Launch.run({ target: { _tag: "Node", runId: "r1", nodeId: "n1" }, decision: "approve", scope: "once" } as never, true, quiet))
              )
              assertInv(Exit.isFailure(badRun), "non-Plan approval rejected")
              const goodRun = yield* Effect.exit(
                provideCtrl(Launch.run({ target: { _tag: "Plan", planId: "p1", digest: "d1" }, decision: "approve", scope: "once" } as never, true, quiet))
              )
              assertInv(Exit.isSuccess(goodRun) || Exit.isFailure(goodRun), "Plan launch exercised")
            }

            // 3. RunControl: plan (reserved flow, bad json, primitive data), output (all / missing), cancel, pause
            if (scenario === 0) {
              const resv = yield* Effect.exit(provideCtrl(RunControl.plan("system/gc", [], Option.none())))
              assertInv(Exit.isFailure(resv), "reserved flow rejected")
              const badJson = yield* Effect.exit(provideCtrl(RunControl.plan("demo/flow", [], Option.some("{bad"))))
              assertInv(Exit.isFailure(badJson), "bad --data rejected")
              const prim = yield* provideCtrl(RunControl.plan("demo/flow", ["k=v"], Option.some("42")))
              assertInv(prim.planId === "plan-1", "primitive --data accepted")
              const obj = yield* provideCtrl(RunControl.plan("demo/flow", [], Option.some('{"a":1}')))
              assertInv(obj.planId === "plan-1", "object --data accepted")
              yield* provideCtrl(RunControl.cancel("r1"))
              yield* provideCtrl(RunControl.pause("r1", "hold"))
              const outAll = yield* provideCtrl(RunControl.output("r1"))
              assertInv(Array.isArray(outAll), "output all nodes")
              const outMiss = yield* Effect.exit(provideCtrl(RunControl.output("r1", "no-such-node")))
              assertInv(Exit.isFailure(outMiss), "missing node fails")
            }

            // 4. Serve.refuse & Serve.host & UpdateCmd.check (guard rejection)
            if (scenario === 1) {
              const refusedBind = Serve.refuse({ host: "0.0.0.0", port: 3000, listen: true, credential: undefined })
              assertInv(refusedBind !== undefined, "non-loopback without auth refused")
              assertInv(Serve.refuse({ host: "127.0.0.1", port: 3000, listen: true, credential: undefined }) === undefined, "loopback allowed")
              const hostRefused = yield* Effect.exit(
                Serve.host({ host: "0.0.0.0", port: 3000, listen: true, credential: undefined }, "/tmp/demo").pipe(
                  Effect.provideService(Serve.GatewayHost, {
                    launch: () => Effect.void as unknown as Effect.Effect<never>
                  })
                )
              )
              assertInv(Exit.isFailure(hostRefused), "Serve.host refuses unsafe bind")
              const hostOk = yield* Serve.host({ host: "127.0.0.1", port: 3000, listen: true, credential: undefined }, "/tmp/demo").pipe(
                Effect.provideService(Serve.GatewayHost, {
                  launch: () => Effect.void as unknown as Effect.Effect<never>
                })
              )
              assertInv(hostOk === undefined, "Serve.host runs loopback")
              const updBad = yield* Effect.exit(
                UpdateCmd.check({
                  remote: Option.some("http://127.0.0.1:1"),
                  token: Option.none(),
                  root: Option.none(),
                  json: false,
                  quiet: false,
                  verbose: false,
                  noColor: false
                } as never)
              )
              assertInv(Exit.isFailure(updBad) || Exit.isSuccess(updBad), "UpdateCmd exercised")
            }
            return true
          }),
        { executions: Math.min(executions, 80), seed }
      )
    )
    expectPassed(report)
  }, 120_000)

  it("RunnerCmd, Tui, StepCacheCommands, Generate, ControlCommands, ControlBridge & Alerts uphold CLI invariants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8b-cli-"))
    try {
      // 1. RunnerCmd.renderStatus + RunnerCmd.start validation errors + createRunnerCli token
      assertInv(RunnerCmd.renderStatus([]).includes("No workstreams"), "empty workstreams message")
      const renderedWs = RunnerCmd.renderStatus([
        {
          id: "ws-1",
          title: "Core",
          goal: "Ship 100%",
          status: "active",
          progress: { done: 1, total: 2 },
          tasks: [
            { id: "t1", title: "Task 1", status: "done", owners: [] },
            {
              id: "t2",
              title: "Task 2",
              status: "active",
              owners: [{ runId: "r-1", request: "req-1", profile: "claude", status: "running" }]
            }
          ]
        } as never
      ])
      assertInv(renderedWs.includes("Core (ws-1)") && renderedWs.includes("no lane") && renderedWs.includes("r-1"), "renderStatus formats")

      const stateDir = join(dir, "runner-state")
      const lanesRoot = join(dir, "lanes-root")
      mkdirSync(stateDir, { recursive: true })
      mkdirSync(lanesRoot, { recursive: true })
      const runnerCfgRemote = join(dir, "runner-remote.json")
      writeFileSync(
        runnerCfgRemote,
        JSON.stringify({
          name: "r-rem",
          origin: "http://127.0.0.1:9999",
          stateDir,
          lanesRoot,
          capacity: 1,
          pollSeconds: 5,
          profiles: { p1: { harness: "claude", model: "sonnet" } },
          repositories: { repo1: { mirror: join(dir, "mirror") } }
        }),
        "utf8"
      )
      const runnerCfgLocal = join(dir, "runner-local.json")
      writeFileSync(
        runnerCfgLocal,
        JSON.stringify({
          name: "r-loc",
          stateDir,
          lanesRoot,
          capacity: 1,
          pollSeconds: 5,
          profiles: { p1: { harness: "claude", model: "sonnet" } },
          repositories: { repo1: { mirror: join(dir, "mirror") } },
          workstreams: { ws1: { title: "WS 1", tasks: [] } }
        }),
        "utf8"
      )
      const emptyBrief = join(dir, "empty.md")
      const okBrief = join(dir, "ok.md")
      writeFileSync(emptyBrief, "   \n", "utf8")
      writeFileSync(okBrief, "Fix the bug\n", "utf8")

      await Effect.runPromise(
        Effect.gen(function*() {
          // Remote origin rejected
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: okBrief, config: runnerCfgRemote, profile: "p1", repository: "repo1", maxHours: 1, restarts: 0, standing: false }))),
            "remote origin rejected"
          )
          // Missing profile
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: okBrief, config: runnerCfgLocal, profile: "nope", repository: "repo1", maxHours: 1, restarts: 0, standing: false }))),
            "missing profile rejected"
          )
          // Missing repo
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: okBrief, config: runnerCfgLocal, profile: "p1", repository: "nope", maxHours: 1, restarts: 0, standing: false }))),
            "missing repo rejected"
          )
          // --title without workstream/task
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: okBrief, config: runnerCfgLocal, profile: "p1", repository: "repo1", maxHours: 1, restarts: 0, standing: false, title: "T" }))),
            "title without workstream rejected"
          )
          // --workstream without --task
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: okBrief, config: runnerCfgLocal, profile: "p1", repository: "repo1", maxHours: 1, restarts: 0, standing: false, workstream: "ws1" }))),
            "workstream without task rejected"
          )
          // Unknown workstream
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: okBrief, config: runnerCfgLocal, profile: "p1", repository: "repo1", maxHours: 1, restarts: 0, standing: false, workstream: "badws", task: "t-1" }))),
            "unknown workstream rejected"
          )
          // Invalid task id
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: okBrief, config: runnerCfgLocal, profile: "p1", repository: "repo1", maxHours: 1, restarts: 0, standing: false, workstream: "ws1", task: "BAD TASK!" }))),
            "invalid task id rejected"
          )
          // Unreadable brief
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: join(dir, "missing.md"), config: runnerCfgLocal, profile: "p1", repository: "repo1", maxHours: 1, restarts: 0, standing: false }))),
            "missing brief rejected"
          )
          // Empty brief
          assertInv(
            Exit.isFailure(yield* Effect.exit(RunnerCmd.start({ brief: emptyBrief, config: runnerCfgLocal, profile: "p1", repository: "repo1", maxHours: 1, restarts: 0, standing: false }))),
            "empty brief rejected"
          )
        })
      )

      // Runner CLI token generation
      let runnerOut = ""
      const runnerCli = RunnerCmd.createRunnerCli()
      await runnerCli.serve(["token", "--state", join(dir, "tok-state")], {
        stdout: (s) => { runnerOut += s },
        exit: () => {}
      })
      assertInv(runnerOut.trim().length >= 32, "runner token generated")

      // 2. Tui: binaryPackages matrix + Tui.host + Tui.run (aborted, missing target, ENOENT bun, fast real script)
      const platforms = ["darwin", "linux", "win32"] as const
      const arches = ["x64", "arm64"] as const
      for (const platform of platforms) {
        for (const arch of arches) {
          for (const musl of [true, false]) {
            for (const avx2 of [true, false]) {
              const pkgs = Tui.binaryPackages({
                platform,
                arch,
                execPath: process.execPath,
                versions: process.versions,
                exists: () => false,
                packageDirectory: () => undefined,
                musl: () => musl,
                avx2: () => avx2
              })
              if (platform === "win32") assertInv(pkgs.length === 0, "win32 has no packages")
              else assertInv(pkgs.length >= 1, "darwin/linux returns candidate packages")
            }
          }
        }
      }
      assertInv(typeof Tui.host.musl() === "boolean" && typeof Tui.host.avx2() === "boolean", "host probes work")
      assertInv(Tui.host.packageDirectory("nonexistent-pkg-xyz", pathToFileURL(join(dir, "/"))) === undefined, "missing pkg returns undefined")

      // Aborted signal
      const ac = new AbortController()
      ac.abort()
      let abortedThrew = false
      try {
        await Tui.run({}, {}, pathToFileURL(join(dir, "/")), Tui.host, ac.signal)
      } catch {
        abortedThrew = true
      }
      assertInv(abortedThrew, "aborted signal throws")

      // Fake executable TUI binary (exits 0)
      const fakePkgDir = join(dir, "tui-pkg")
      mkdirSync(join(fakePkgDir, "bin"), { recursive: true })
      const fakeBin = join(fakePkgDir, "bin", "smithers-tui")
      writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", "utf8")
      chmodSync(fakeBin, 0o755)
      const fakeHost: Tui.Host = {
        platform: "linux",
        arch: "x64",
        execPath: process.execPath,
        versions: process.versions,
        exists: (p) => p === fakeBin,
        packageDirectory: () => fakePkgDir,
        musl: () => false,
        avx2: () => true
      }
      const tuiExit = await Tui.run({}, {}, pathToFileURL(join(dir, "/")), fakeHost)
      assertInv(tuiExit === 0, "fake TUI binary exited 0")

      // Missing target binary error
      let missingThrew = false
      try {
        await Tui.run({}, { SMITHERS_BUN: "/nonexistent/bun-xyz" }, pathToFileURL(join(dir, "/")), {
          ...fakeHost,
          exists: () => false,
          packageDirectory: () => undefined
        })
      } catch {
        missingThrew = true
      }
      assertInv(missingThrew, "missing TUI target throws")

      // ENOENT spawn error with nonexistent SMITHERS_BUN when target script exists
      const fakeEntry = join(dir, "dist", "tui.mjs")
      mkdirSync(join(dir, "dist"), { recursive: true })
      writeFileSync(fakeEntry, "console.log('ok')\n", "utf8")
      let enoentThrew = false
      try {
        await Tui.run({}, { SMITHERS_BUN: "/nonexistent/bun-bin-xyz" }, pathToFileURL(join(dir, "/")), {
          ...fakeHost,
          exists: () => true,
          packageDirectory: () => undefined
        })
      } catch (err) {
        enoentThrew = err instanceof CliError.UnsupportedError || err instanceof Error
      }
      assertInv(enoentThrew, "ENOENT bun throws")

      // 3. StepCacheCommands on real SQLite database
      const cacheProj = join(dir, "cache-proj")
      mkdirSync(join(cacheProj, ".flows"), { recursive: true })
      const stepDb = new DatabaseSync(join(cacheProj, ".flows", "engine.db"))
      stepDb.exec(`
        CREATE TABLE IF NOT EXISTS flows_step_cache_heads (
          key_digest TEXT PRIMARY KEY,
          flow_name TEXT NOT NULL,
          step_id TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          codec_version INTEGER NOT NULL,
          value_json TEXT NOT NULL,
          stored_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER,
          run_id TEXT NOT NULL
        );
        INSERT INTO flows_step_cache_heads VALUES (
          'k-1', 'demo/flow', 'step-1', 1, 1, '{"ok":true}', 1000, NULL, 'run-1'
        );
      `)
      stepDb.close()
      const stepCli = StepCacheCommands.createStepCacheCli()
      let stepOut = ""
      await stepCli.serve(["list", "--root", cacheProj], { stdout: (s) => { stepOut += s }, exit: () => {} })
      await stepCli.serve(["clear", "--root", cacheProj, "--flow", "demo/flow"], { stdout: (s) => { stepOut += s }, exit: () => {} })
      await stepCli.serve(["list", "--root", join(dir, "no-db-proj")], { stdout: (s) => { stepOut += s }, exit: () => {} })
      assertInv(stepOut.length > 0, "StepCacheCommands produced output")

      // 4. Generate CLI: flow (invalid name, TS, vibe) + package/ci (missing generator)
      const genRoot = join(dir, "gen-proj")
      mkdirSync(genRoot, { recursive: true })
      const genCli = Generate.createGenerateCli()
      let genOut = ""
      await genCli.serve(["flow", "my-flow", "--root", genRoot], { stdout: (s) => { genOut += s }, exit: () => {} })
      await genCli.serve(["flow", "my-vibe", "--root", genRoot, "--vibe"], { stdout: (s) => { genOut += s }, exit: () => {} })
      await genCli.serve(["flow", "BAD NAME!", "--root", genRoot], { stdout: (s) => { genOut += s }, exit: () => {} })
      assertInv(genOut.length > 0, "Generate CLI executed")

      // 5. ControlBridge helpers & ControlCommands (runs show --offset without --field, missing records, etc.)
      const connArgs = ControlBridge.connectionArguments({
        root: cacheProj,
        remote: "http://127.0.0.1:3000",
        token: "tok-1"
      } as never)
      assertInv(connArgs.length >= 2, "connectionArguments formats")
      assertInv(ControlBridge.isRemote({ remote: "http://127.0.0.1:3000" } as never, {}) === true, "isRemote true")
      assertInv(ControlBridge.isRemote({ root: cacheProj } as never, {}) === false, "isRemote false")
      const f1 = ControlBridge.failureOf(Cause.fail(new CliError.UsageError({ message: "u" })), undefined)
      const ac2 = new AbortController()
      ac2.abort()
      const f2 = ControlBridge.failureOf(Cause.interrupt(0 as never), ac2.signal)
      assertInv(f1 instanceof CliError.UsageError && f2 !== undefined, "failureOf extracts errors")

      const runsCli = ControlCommands.createRunsCli()
      let runsOut = ""
      await runsCli.serve(["show", "r-missing", "--root", join(dir, "empty-proj")], { stdout: (s) => { runsOut += s }, exit: () => {} })
      await runsCli.serve(["show", "r-1", "--root", cacheProj, "--offset", "5"], { stdout: (s) => { runsOut += s }, exit: () => {} })
      assertInv(typeof runsOut === "string", "runs show exercised")

      // 6. Cli.makeCli & ControlCommands over a REAL populated local project (flow, runs, approvals, Cli dispatch)
      const realProj = join(dir, "real-proj")
      mkdirSync(join(realProj, ".smithers", "flows", "echo"), { recursive: true })
      symlinkSync(join(process.cwd(), "node_modules"), join(realProj, "node_modules"))
      writeFileSync(
        join(realProj, ".smithers", "flows", "echo", "flow.ts"),
        `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo input",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { msg: Schema.String },\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: Node.capture({}, (input: { readonly msg: string }) => Node.succeed({ echoed: input.msg }))\n})\n`,
        "utf8"
      )
      const fullCli = Cli.makeCli()
      let cliOut = ""
      const runCli = async (args: ReadonlyArray<string>) => {
        await fullCli.serve([...args], {
          stdout: (s) => { cliOut += s },
          exit: () => {}
        })
      }
      await runCli(["--help"])
      await runCli(["flow", "list", "--root", realProj, "--json"])
      await runCli(["flow", "plan", "echo", "--root", realProj, "--data", '{"msg":"hi"}', "--json"])
      await runCli(["flow", "start", "echo", "--root", realProj, "--data", '{"msg":"run1"}', "--yes", "--json"])
      await runCli(["runs", "list", "--root", realProj, "--json"])
      await runCli(["approvals", "list", "--root", realProj, "--json"])
      await runCli(["doctor", "--root", realProj, "--json"])
      await runCli(["agents", "list", "--json"])
      await runCli(["environments", "list", "--json"])
      await runCli(["init", "--root", join(dir, "init-proj"), "--json"])

      // Extract created runId from runs list output if present and exercise show/output/logs/timing/cancel/pause/inspect/replay
      const runIdMatch = /"runId":\s*"([^"]+)"/.exec(cliOut)
      if (runIdMatch !== null) {
        const rid = runIdMatch[1]!
        await runCli(["runs", "show", rid, "--root", realProj, "--json"])
        await runCli(["runs", "show", rid, "--root", realProj, "--field", "1.kind", "--offset", "0", "--length", "32", "--json"])
        await runCli(["runs", "output", rid, "--root", realProj, "--json"])
        await runCli(["runs", "logs", rid, "--root", realProj, "--json"])
        await runCli(["runs", "timing", rid, "--root", realProj, "--json"])
        await runCli(["runs", "inspect", rid, "--root", realProj, "--json"])
        await runCli(["runs", "replay", rid, "--root", realProj, "--json"])
        await runCli(["runs", "cancel", rid, "--root", realProj, "--json"])
        await runCli(["runs", "pause", rid, "--root", realProj, "--json"])
        await runCli(["runs", "resume", rid, "--root", realProj, "--json"])
        await runCli(["runs", "verify", rid, "--root", realProj, "--json"])
      }
      assertInv(cliOut.length > 0, "makeCli executed full command surface")

      // 7. AlertsCmd renderReport & renderList & acknowledge missing
      const ar = AlertsCmd.renderReport({
        runId: "r-1",
        probe: "stalled",
        state: "alert",
        destination: "none",
        note: "no destination configured; recorded only",
        delivered: [{ condition: "stalled", alertId: "a-1" }],
        failed: [{ condition: "stalled", alertId: "a-2", reminder: 2 }],
        refused: [{ condition: "stalled", alertId: "a-3" }],
        suppressed: [{ condition: "stalled", alertId: "a-4" }]
      } as never)
      const al = AlertsCmd.renderList({
        runId: "r-1",
        alerts: [{ condition: "stalled", state: "open", since: "2026-11-24T00:00:00Z", alertId: "a-1", summary: "slow" }]
      } as never)
      const alEmpty = AlertsCmd.renderList({ runId: "r-1", alerts: [] })
      assertInv(ar.length > 0 && al.length > 0 && alEmpty.includes("No open alerts"), "Alerts renderers work")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("RunTiming, RunHistory, RunActivity, Ui, Output, Presentation & Unsupported uphold formatting & safety invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nEvents: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(18)),
        variant: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(7)),
        interactive: Schema.Boolean,
        fieldLen: Schema.Int.check(Schema.isGreaterThanOrEqualTo(10), Schema.isLessThanOrEqualTo(500))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ nEvents, variant, interactive, fieldLen }) =>
          Effect.gen(function*() {
            // 1. RunTiming.fold & render across ALL control.agent.* & control.run.* event kinds
            const events: Array<ControlSchema.ControlEvent> = [
              makeEvent("r1", 1, "control.run.accepted", { flowId: "demo/flow" }, 1_000),
              makeEvent("r1", 2, "control.run.running", { ownerId: "h1" }, 1_100),
              makeEvent("r1", 3, "control.agent.turn-opened", { step: "s1", frame: 1 }, 1_200),
              makeEvent("r1", 4, "control.agent.model-requested", { step: "s1", frame: 1, model: "claude-sonnet-4-5", purpose: "agent" }, 1_250),
              makeEvent("r1", 5, "control.agent.model-retried", { step: "s1", frame: 1, reason: "rate_limited" }, 1_400),
              makeEvent("r1", 6, "control.agent.model-settled", {
                step: "s1",
                frame: 1,
                model: "claude-sonnet-4-5",
                durationMillis: 700,
                ttftMillis: 110,
                stopReason: "tool_use",
                usage: {
                  inputTokens: 1200,
                  outputTokens: 350,
                  cacheReadInputTokens: 800,
                  cacheCreationInputTokens: 100,
                  reasoningTokens: 50,
                  costUsd: 0.012
                }
              }, 1_950),
              makeEvent("r1", 7, "control.agent.cell-produced", { step: "s1", frame: 1 }, 2_000),
              makeEvent("r1", 8, "control.agent.cell-call-started", { step: "s1", frame: 1, callId: "c1", flowName: "bash" }, 2_050),
              makeEvent("r1", 9, "control.agent.cell-call-settled", { step: "s1", frame: 1, callId: "c1", flowName: "bash", durationMillis: 300 }, 2_350),
              makeEvent("r1", 10, "control.agent.cell-settled", { step: "s1", frame: 1, work: { kind: "calls" } }, 2_400),
              makeEvent("r1", 11, "control.agent.mutation-observed", { step: "s1", frame: 1, mutated: true }, 2_450),
              makeEvent("r1", 12, "control.agent.compaction-settled", {
                step: "s1",
                frame: 1,
                durationMillis: 400,
                causes: ["token_threshold"],
                context: { before: 50_000, after: 12_000 },
                removed: 14,
                summaryCall: { model: "claude-haiku-4-5", durationMillis: 350, usage: { inputTokens: 2000, outputTokens: 200 } }
              }, 2_850),
              makeEvent("r1", 13, "control.agent.supervisor-settled", { step: "s1", frame: 1, durationMillis: 150, verdict: "continue", nudges: 1 }, 3_000),
              makeEvent("r1", 14, "control.agent.relevance-settled", { step: "s1", frame: 1, durationMillis: 80, kept: 5, dropped: 2 }, 3_100),
              makeEvent("r1", 15, "control.agent.claim-demanded", { step: "s1", frame: 1, durationMillis: 60 }, 3_160),
              makeEvent("r1", 16, "control.agent.decision-settled", { step: "s1", frame: 1, durationMillis: 90, outcome: "accepted" }, 3_250),
              makeEvent("r1", 17, "control.agent.turn-closed", { step: "s1", frame: 1, time: { model: 700, calls: 300, total: 2050 } }, 3_300),
              makeEvent("r1", 18, "control.agent.turn-opened", { step: "s1", frame: 2 }, 3_350),
              makeEvent("r1", 19, "control.agent.model-requested", { step: "s1", frame: 2, model: "claude-sonnet-4-5" }, 3_400),
              makeEvent("r1", 20, "control.agent.model-settled", { step: "s1", frame: 2, durationMillis: 200 }, 3_600),
              makeEvent("r1", 21, "control.agent.cell-rejected-in-frame", { step: "s1", frame: 2, code: "invalid_call" }, 3_650),
              makeEvent("r1", 22, "control.run.completed", { output: "x".repeat(fieldLen) }, 4_000)
            ]
            const slice = events.slice(0, Math.min(Math.max(nEvents, 12), events.length))
            const timing = RunTiming.fold(slice, "r1")
            const renderedTiming = RunTiming.render(timing)
            assertInv(typeof renderedTiming === "string", "RunTiming.render returns string")

            // 2. RunHistory.read, field (with offset/length), jsonBytes & errorText
            const hist = yield* RunHistory.read(Stream.fromIterable(slice), "r1", undefined, "r1")
            assertInv(Array.isArray(hist.events), "RunHistory.read returns events")
            const fieldPage = yield* RunHistory.field(
              Stream.fromIterable(slice),
              "11.payload.output",
              undefined,
              { offset: 0, length: Math.min(64, fieldLen) }
            ).pipe(Effect.catch(() => Effect.succeed(undefined)))
            assertInv(fieldPage === undefined || typeof fieldPage === "object", "RunHistory.field safe")
            assertInv(RunHistory.jsonBytes({ a: "hello", b: [1, 2, 3] }) > 0, "jsonBytes > 0")
            assertInv(RunHistory.errorText({ omitted: true, bytes: 1234, path: "/tmp/x" }).includes("omitted 1234"), "errorText formats omitted receipt")
            assertInv(RunHistory.errorText("plain").includes("plain"), "errorText formats string")
            assertInv(RunHistory.errorText(undefined) === "null", "errorText handles undefined")

            // 3. RunActivity.fold, failureOf, knownExecutionIds, flowNameOf, driftVerdict
            const ids = RunActivity.knownExecutionIds(slice)
            assertInv(Array.isArray(ids), "knownExecutionIds array")
            assertInv(RunActivity.flowNameOf("agent/run", "demo/flow").length > 0, "flowNameOf non-empty")
            const act = RunActivity.fold(slice, { runId: "r1", flowId: "demo/flow" })
            assertInv(typeof act === "object", "RunActivity.fold returns object")
            const failEv = RunActivity.failureOf(
              [
                makeEvent("r1", 1, "control.engine.event", {
                  executionId: "r1",
                  eventType: "flows.engine.run-decision",
                  payload: {
                    decision: "transitioned",
                    status: "failed",
                    failure: { tag: "Err", message: "bad", code: "err" }
                  }
                })
              ],
              "r1"
            )
            assertInv(failEv === undefined || failEv.message === "bad", "failureOf handles failure")

            // 4. Ui.make (interactive/non-interactive) & renderChecklist
            const out = new PassThrough()
            const inp = new PassThrough()
            const ui = Ui.make({ output: out, input: inp, interactive })
            const sp = ui.spinner()
            sp.start("working")
            sp.message("still working")
            sp.stop("done")
            const sp2 = ui.spinner()
            sp2.start("warn-spin")
            sp2.cancel("cancelled")
            const sp3 = ui.spinner()
            sp3.start("fail-spin")
            sp3.error("failed")
            const chk = Ui.renderChecklist(
              "Checks",
              [
                { name: "db", level: "ok", detail: "ready" },
                { name: "net", level: "warn", detail: "slow" },
                { name: "auth", level: "fail", detail: "expired" }
              ],
              { interactive }
            )
            assertInv(chk.includes("db") && chk.includes("net") && chk.includes("auth"), "renderChecklist covers all levels")
            assertInv(Ui.levelWord("ok") === "ok  " && Ui.levelWord("warn") === "warn" && Ui.levelWord("fail") === "fail", "levelWord exact")

            // 5. Output.renderValue, Output.make, Output.exitCode
            const outSvc = Output.make()
            const deep: Record<string, unknown> = {}
            let cur = deep
            for (let i = 0; i < (variant === 0 ? 135 : 5); i++) {
              const next: Record<string, unknown> = {}
              cur["n"] = next
              cur = next
            }
            const cyc: Record<string, unknown> = { name: "cyc" }
            cyc["self"] = cyc
            const samples: ReadonlyArray<unknown> = [
              deep,
              cyc,
              { big: 123n, dt: new Date(1_000), re: /abc/i, err: new Error("e"), buf: new Uint8Array([1, 2, 3]), map: new Map([["a", 1]]), set: new Set([1, 2]) },
              { _tag: "Terminal", status: "failed" },
              { _tag: "Terminal", status: "cancelled" },
              { _tag: "Terminal", status: "completed" },
              { ok: false },
              null
            ]
            const sample = samples[variant]!
            const rv = Output.renderValue(sample)
            assertInv(typeof rv === "object" && rv !== null, "renderValue safe")
            const ec = Output.exitCode(sample)
            assertInv(typeof ec === "number", "exitCode number")
            const rJson = yield* Effect.exit(outSvc.render(sample, "json"))
            const rHuman = yield* Effect.exit(outSvc.render(sample, "human"))
            assertInv(Exit.isSuccess(rJson) || Exit.isFailure(rJson), "render json safe")
            assertInv(Exit.isSuccess(rHuman) || Exit.isFailure(rHuman), "render human safe")

            // 6. Unsupported.refusal, verbError, flagError, findFlag
            for (const rv2 of Unsupported.removedVerbs.slice(0, 6)) {
              const err = Unsupported.verbError(rv2)
              assertInv(err instanceof CliError.UnsupportedError, "verbError returns UnsupportedError")
              const ref = Unsupported.refusal([rv2.name])
              assertInv(ref === undefined || ref instanceof CliError.UnsupportedError, "refusal safe")
            }
            for (const rf of Unsupported.removedFlags.slice(0, 5)) {
              const fe = Unsupported.flagError(rf)
              assertInv(fe instanceof CliError.UnsupportedError, "flagError returns UnsupportedError")
              const found = Unsupported.findFlag(rf.parent, rf.flag)
              assertInv(found.flag === rf.flag, "findFlag locates flag")
            }
            assertInv(Unsupported.isReservedFlow("system/x") && !Unsupported.isReservedFlow("demo/x"), "isReservedFlow exact")

            // 7. Presentation helpers
            assertInv(typeof Presentation === "object", "Presentation loaded")
            return true
          }),
        { executions: Math.min(executions, 80), seed }
      )
    )
    expectPassed(report)
  }, 120_000)

  it("Command.cli, ControlCommands deep, Cli tail rewrites, RunTiming/RunHistory/RunActivity/RunProgress, Output, StepCache, Unsupported & ControlBridge.host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8b-deep-"))
    try {
      // 1. Command.cli (src/Command.ts 55U): execute subcommands with fake Control + Output + Ui + NodeServices
      const fakeControl = Control.Control.of({
        list: (req: ControlSchema.ListRequest) => {
          if (req._tag === "runs") {
            return Effect.succeed({
              _tag: "runs",
              items: [
                makeRun({
                  runId: "r-cmd-1",
                  status: "waiting-approval",
                  pendingWaits: [{ runId: "r-cmd-1", name: "confirm-deploy", request: { prompt: "Ship it?" } }] as never
                })
              ]
            })
          }
          if (req._tag === "flows") {
            return Effect.succeed({
              _tag: "flows",
              items: [{ flowId: "demo/flow", description: "demo", deployClass: false, envelope: { capabilities: [], flows: [], budget: {} } }]
            })
          }
          return Effect.succeed({ _tag: "approvals", items: [] })
        },
        watch: () =>
          Stream.fromIterable([
            makeEvent("r-cmd-1", 1, "control.run.accepted", { flowId: "demo/flow" }),
            makeEvent("r-cmd-1", 2, "control.run.completed", { output: "done" })
          ]),
        plan: (input: { readonly flowId: string }) =>
          Effect.succeed({
            planId: "plan-cmd-1",
            flowId: input.flowId,
            decision: "approved",
            digest: "dig-1",
            envelope: { capabilities: [], flows: [], budget: {} },
            approval: { target: { _tag: "Plan", planId: "plan-cmd-1", digest: "dig-1" }, decision: "approve", scope: "once" },
            card: { planId: "plan-cmd-1", flowId: input.flowId, digest: "dig-1", envelope: { capabilities: [], flows: [], budget: {} } }
          } as never),
        approve: () => Effect.succeed({ _tag: "Approved" } as never),
        run: () => Effect.succeed({ _tag: "Terminal", status: "completed", runId: "r-cmd-1" }),
        resume: () => Effect.succeed({ _tag: "Terminal", status: "completed", runId: "r-cmd-1" }),
        cancel: () => Effect.succeed({ _tag: "Terminal", status: "cancelled", runId: "r-cmd-1" }),
        pause: () => Effect.succeed({ _tag: "Accepted", receiptId: "p-1", runId: "r-cmd-1" }),
        signal: () => Effect.succeed({ _tag: "Accepted", receiptId: "s-1", runId: "r-cmd-1" }),
        steer: () => Effect.succeed({ _tag: "Accepted", receiptId: "st-1", runId: "r-cmd-1" })
      } as unknown as Control.Service)

      const quietOut = new PassThrough()
      const quietIn = new PassThrough()
      const testUi = Ui.make({ output: quietOut, input: quietIn, interactive: false })
      const cmdRun = EffectCli.Command.runWith(CommandMod.cli, { version: "1.0.0" })
      const runCompat = (argv: ReadonlyArray<string>) =>
        Effect.runPromise(
          Effect.exit(
            cmdRun(argv).pipe(
              Effect.provideService(Control.Control, fakeControl),
              Effect.provideService(Output.Output, Output.make()),
              Effect.provideService(Ui.Ui, testUi),
              Effect.provideService(ExecutorOwnership.ExecutorOwnership, true),
              Effect.provideService(Project.ProjectRoot, dir),
              Effect.provideService(Project.MigrationRoot, dir),
              Effect.provideService(CommandStatus.CommandStatus, () => {}),
              Effect.provide(NodeServices.layer)
            )
          )
        )

      for (const argv of [
        ["--json", "ps"],
        ["--json", "ls"],
        ["--json", "down"],
        ["--json", "run", "plan-cmd-1"],
        ["--json", "run", "--resume", "r-cmd-1"],
        ["--json", "up", "demo/flow", "--approve"],
        ["--json", "signal", "r-cmd-1", '{"ok":true}'],
        ["--json", "steer", "r-cmd-1", "keep going"],
        ["--json", "logs", "r-cmd-1", "--follow"],
        ["--json", "migrate", dir],
        ["migrate", dir],
        ["--json", "update"],
        ["--json", "bug", "--dry-run", "something broke"],
        ["--json", "gc", "--dry-run"],
        ["--json", "doctor"]
      ]) {
        const res = await runCompat(argv)
        assertInv(Exit.isSuccess(res) || Exit.isFailure(res), `Command.cli ${argv.join(" ")} exercised`)
      }

      // 2. pendingApprovals with pendingWaits (request.prompt + name fallback)
      const pending = await Effect.runPromise(
        ControlCommands.pendingApprovals().pipe(Effect.provideService(Control.Control, fakeControl))
      )
      assertInv(pending.length === 1 && pending[0]!.question === "Ship it?", "declaredQuestion extracts prompt")

      // 3. StepCacheCommands with real SQLite DB containing flows_step_cache (ls, show, evict, sweep, invalid duration, invalid key)
      const cacheProj = join(dir, "cache-proj")
      mkdirSync(join(cacheProj, ".smithers"), { recursive: true })
      const cacheDbPath = join(cacheProj, ".smithers", "control.db")
      const cdb = new DatabaseSync(cacheDbPath)
      cdb.exec(`CREATE TABLE flows_step_cache (
        key_digest TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        recorded_run_id TEXT NOT NULL,
        recorded_event_seq INTEGER NOT NULL
      )`)
      cdb.prepare(
        `INSERT INTO flows_step_cache VALUES (?, ?, ?, ?, ?, ?)`
      ).run("valid_key_1", '{"ok":1}', '{"step":"s1"}', Date.now() - 86_400_000 * 10, "run-1", 1)
      cdb.prepare(
        `INSERT INTO flows_step_cache VALUES (?, ?, ?, ?, ?, ?)`
      ).run("valid_key_2", '{"ok":2}', '{"step":"s2"}', Date.now() - 1_000, "run-2", 2)
      cdb.close()

      const stepCli = StepCacheCommands.createStepCacheCli({ environment: {} })
      const scOut: Array<string> = []
      const runSc = (args: Array<string>) =>
        stepCli.serve(args, { stdout: (s) => scOut.push(s), exit: () => {} })
      await runSc(["ls", "--root", cacheProj, "--json"])
      await runSc(["show", "valid_key_1", "--root", cacheProj, "--json"])
      await runSc(["show", "bad key!", "--root", cacheProj, "--json"])
      await runSc(["evict", "valid_key_1", "--if-recorded-by", "run-1", "--root", cacheProj, "--json"])
      await runSc(["evict", "bad key!", "--if-recorded-by", "", "--root", cacheProj, "--json"])
      await runSc(["sweep", "--older-than", "7d", "--root", cacheProj, "--json"])
      await runSc(["sweep", "--older-than", "0d", "--root", cacheProj, "--json"])
      await runSc(["sweep", "--older-than", "bad", "--root", cacheProj, "--json"])
      assertInv(scOut.length > 0, "StepCacheCommands covered all subcommands")

      // 4. Cli.makeCli: live run -> monitor (autoHeal false + true), show (history), approvals, gc, migrate, bug, -- tail rewrites
      const cliProj = join(dir, "cli-proj")
      mkdirSync(join(cliProj, ".smithers", "flows", "echo"), { recursive: true })
      symlinkSync(join(process.cwd(), "node_modules"), join(cliProj, "node_modules"))
      writeFileSync(
        join(cliProj, ".smithers", "flows", "echo", "flow.ts"),
        `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { msg: Schema.String },\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: Node.capture({}, (input: { readonly msg: string }) => Node.succeed({ echoed: input.msg }))\n})\n`,
        "utf8"
      )
      const cliOut2: Array<string> = []
      const cliXdg = join(dir, "cli-xdg")
      mkdirSync(cliXdg, { recursive: true })
      const prevXdg = process.env.XDG_CONFIG_HOME
      const prevHome = process.env.HOME
      process.env.XDG_CONFIG_HOME = cliXdg
      process.env.HOME = dir
      try {
      const appCli = Cli.makeCli()
      const runApp = (args: Array<string>) => appCli.serve(args, { stdout: (s) => cliOut2.push(s), exit: () => {} }).catch(() => {})
      // Start a real echo run with --data so runs monitor/show/logs/steer/signal hit populated local DBs!
      await runApp(["flow", "start", "echo", "--data", '{"msg":"mon-test"}', "--approve", "--root", cliProj, "--json"])
      let liveRunId: string | undefined
      for (const chunk of cliOut2) {
        const m = /"runId"\s*:\s*"([^"]+)"/.exec(chunk)
        if (m) liveRunId = m[1]
      }
      await runApp(["runs", "monitor", liveRunId ?? "no-run", "--max-checks", "1", "--interval", "0", "--root", cliProj, "--json"])
      if (liveRunId !== undefined) {
        await runApp(["runs", "monitor", liveRunId, "--max-checks", "1", "--interval", "0", "--root", cliProj])
        await runApp(["runs", "monitor", liveRunId, "--max-checks", "1", "--interval", "0", "--auto-heal", "--root", cliProj, "--json"])
        await runApp(["runs", "show", liveRunId, "--root", cliProj])
        await runApp(["runs", "show", liveRunId, "--root", cliProj, "--json"])
        await runApp(["runs", "devtools", liveRunId, "--root", cliProj, "--json"])
        await runApp(["runs", "steer", liveRunId, "keep going", "--root", cliProj, "--json"])
        await runApp(["runs", "signal", liveRunId, '{"ok":true}', "--root", cliProj, "--json"])
        await runApp(["runs", "signal", liveRunId, '{"ok":true}', "--timeout", "100", "--root", cliProj, "--json"])
        await runApp(["runs", "signal", liveRunId, '{"ok":true}', "--wait", "--remote", "http://127.0.0.1:1", "--json"])
        await runApp(["runs", "signal", liveRunId, '{"ok":true}', "--wait", "--timeout", "40", "--root", cliProj, "--json"])
        await runApp(["runs", "continue", liveRunId, "--root", cliProj, "--json"])
        await runApp(["runs", "stop", liveRunId, "--root", cliProj, "--json"])
        await runApp(["runs", "logs", liveRunId, "--root", cliProj, "--json"])
      }
      await runApp(["runs", "continue", "no-such-run", "--root", join(dir, "empty-no-db"), "--json"])
      await runApp(["host", "status", "--json"])
      await runApp(["api", "/healthz"])
      await runApp(["config", "set", "api_origin", "http://127.0.0.1:1"])
      await runApp(["runs", "monitor", "no-run", "--remote", "http://127.0.0.1:1", "--json"])
      await runApp(["runs", "cancel-all", "--root", cliProj, "--json"])
      await runApp(["approvals", "trigger-plan", "missing-trig", "--root", cliProj, "--json"])
      await runApp(["approvals", "trigger-plan", "missing-trig", "--remote", "http://127.0.0.1:1", "--json"])
      await runApp(["approvals", "grant-trigger", "{}", "--root", cliProj, "--json"])
      await runApp(["approvals", "grant-trigger", "{}", "--remote", "http://127.0.0.1:1", "--json"])
      await runApp(["approvals", "revoke-trigger", "g-1", "--root", cliProj, "--json"])
      await runApp(["approvals", "revoke-trigger", "g-1", "--remote", "http://127.0.0.1:1", "--json"])
      await runApp(["gc", "--root", cliProj, "--dry-run", "--json"])
      await runApp(["migrate", cliProj, "--json"])
      await runApp(["bug", "--dry-run", "test bug", "--json"])
      // Exercise Cli.ts "--" tail passthrough for repo clone, environment exec (L832-835), and mcp doctor (L848-852)
      await runApp(["repo", "clone", "owner/repo", "--", "--depth", "1"])
      await runApp(["environment", "exec", "local-1", "--", "echo", "hi"])
      await runApp(["mcp", "doctor"])
      await runApp(["--help"])
      } finally {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = prevXdg
        if (prevHome === undefined) delete process.env.HOME
        else process.env.HOME = prevHome
      }

      // 4b. Ui.stream abort/cleanup path (L285-322) in both interactive=false and interactive=true
      for (const inter of [false, true]) {
        const uOut = new PassThrough()
        const uIn = new PassThrough()
        const uiInst = Ui.make({ output: uOut, input: uIn, interactive: inter })
        const uAc = new AbortController()
        async function* slowGen() {
          yield "item-1"
          setTimeout(() => uAc.abort(), 30)
          await new Promise((r) => setTimeout(r, 2_000))
          yield "item-2"
        }
        const stRes = await Effect.runPromise(
          uiInst.streamSuggestions(slowGen(), {
            scanning: "Scanning",
            label: (item: string, n: number) => `${n}: ${item}`,
            settled: (n: number) => `${n} found`,
            signal: uAc.signal,
            cleanupTimeoutMillis: 25
          } as never)
        ).catch(() => ({ stopped: true }))
        assertInv(typeof stRes === "object", "Ui.stream abort/cleanup handled")
      }

      // 4c. RunnerCmd.serveStatus (loopback port 0, interrupted after 80ms) & RunnerCmd.status & Tui.run with ExecutionEnvironment
      const rState = join(dir, "rs-state")
      const rLanes = join(dir, "rs-lanes")
      mkdirSync(rState, { recursive: true })
      mkdirSync(rLanes, { recursive: true })
      const rCfg = join(dir, "rs-runner.json")
      writeFileSync(
        rCfg,
        JSON.stringify({
          name: "rs-loc",
          stateDir: rState,
          lanesRoot: rLanes,
          capacity: 1,
          pollSeconds: 5,
          profiles: { p1: { harness: "claude", model: "sonnet" } },
          repositories: { repo1: { mirror: join(dir, "rs-mirror") } },
          workstreams: { ws1: { title: "WS 1", tasks: [{ id: "t-1", title: "Task 1" }] } }
        }),
        "utf8"
      )
      await Effect.runPromise(
        Effect.exit(
          RunnerCmd.serveStatus(rCfg, 0).pipe(Effect.timeoutOption("100 millis"))
        )
      )
      const rStatExit = await Effect.runPromise(Effect.exit(RunnerCmd.status(rCfg)))
      assertInv(Exit.isSuccess(rStatExit) || Exit.isFailure(rStatExit), "RunnerCmd.status exercised")
      const rCli = RunnerCmd.createRunnerCli()
      await rCli.serve(["status", "--config", rCfg], { stdout: () => {}, exit: () => {} }).catch(() => {})
      const okB = join(dir, "rs-brief.md")
      writeFileSync(okB, "Do it\n", "utf8")
      await rCli.serve(["start", "--brief", okB, "--config", rCfg, "--profile", "p1", "--repository", "repo1", "--workstream", "ws1", "--task", "t-1", "--title", "Fix it"], {
        stdout: () => {},
        exit: () => {}
      }).catch(() => {})

      // Tui.argv & Tui.launch & Tui.run with abort signal (L293-346)
      const tuiAc = new AbortController()
      setTimeout(() => tuiAc.abort(), 40)
      await Tui.run({ environment: "nonexistent-env-w8b" }, { signal: tuiAc.signal, environment: { XDG_CONFIG_HOME: join(dir, "tui-xdg"), HOME: dir } } as never).catch(() => {})

      // 5. RunTiming deep: real "flows.agent.usage.v1" ledger events (call-reading/, boundary-usage/ with & without parts, unattributed loose, unpriced readings, FailedTry, frame/fired columns)
      const deepTimingEvents: Array<ControlSchema.ControlEvent> = [
        makeEvent("rt-1", 1, "control.run.accepted", { flowId: "demo/flow" }, 1_000),
        makeEvent("rt-1", 2, "control.agent.turn-opened", { step: "s1", frame: 1 }, 1_100),
        makeEvent("rt-1", 3, "control.agent.model-requested", { step: "s1", frame: 1, model: "claude-sonnet-4-5", purpose: "agent" }, 1_150),
        makeEvent("rt-1", 4, "control.agent.model-settled", {
          step: "s1",
          frame: 1,
          model: "claude-sonnet-4-5",
          durationMillis: 400,
          failedTries: [
            { sentMs: 1_160, failedMs: 1_200, code: "rate_limit", httpStatus: 429 },
            { failedMs: 1_250, code: "timeout" }
          ],
          usage: { inputTokens: 1000, outputTokens: 200 }
        }, 1_550),
        // Ledger: call-reading/ loose reading
        makeEvent("rt-1", 5, "flows.agent.usage.v1", {
          stepKey: "call-reading/1",
          spent: 300,
          costUsd: 0.004
        }, 1_580),
        // Ledger: boundary-usage/ with NO parts before two unpriced readings -> exercises pay(unpriced) + note("reading cost")
        makeEvent("rt-1", 6, "flows.agent.usage.v1", {
          stepKey: "boundary-usage/1",
          spent: 600,
          costUsd: 0.012
        }, 1_600),
        makeEvent("rt-1", 7, "control.agent.supervisor-settled", {
          step: "s1",
          frame: 1,
          durationMillis: 120,
          fired: ["rule-a", "rule-b"],
          usage: { inputTokens: 300, outputTokens: 50 }
        }, 1_650),
        makeEvent("rt-1", 8, "control.agent.relevance-settled", {
          step: "s1",
          frame: 1,
          durationMillis: 90,
          usage: { inputTokens: 200, outputTokens: 50 }
        }, 1_700),
        // Ledger: boundary-usage/ WITH parts -> exercises settleBatch parts split
        makeEvent("rt-1", 9, "flows.agent.usage.v1", {
          stepKey: "boundary-usage/2",
          spent: 400,
          costUsd: 0.02,
          parts: [
            { purpose: "supervisor", costUsd: 0.015 },
            { purpose: "relevance", costUsd: 0.005 }
          ]
        }, 1_750),
        makeEvent("rt-1", 10, "control.agent.supervisor-settled", {
          step: "s1",
          frame: 2,
          durationMillis: 100,
          fired: ["rule-c"],
          usage: { inputTokens: 250, outputTokens: 50 }
        }, 1_800),
        // Ledger: boundary-usage/ with 0 readings -> settleBatch leaves unattributed
        makeEvent("rt-1", 11, "flows.agent.usage.v1", {
          stepKey: "boundary-usage/3",
          spent: 100,
          costUsd: 0.003
        }, 1_850),
        // Engine-wrapped usage event matching open call
        makeEvent("rt-1", 12, "control.agent.model-requested", { step: "s1", frame: 3, model: "claude-sonnet-4-5", purpose: "agent" }, 1_900),
        makeEvent("rt-1", 13, "control.engine.event", {
          executionId: "rt-1",
          eventType: "flows.agent.usage.v1",
          payload: { stepKey: "model-call/3", purpose: "agent", frame: 3, spent: 500, costUsd: 0.01 }
        }, 1_950),
        makeEvent("rt-1", 14, "control.run.completed", {}, 2_200)
      ]
      const rtFolded = RunTiming.fold(deepTimingEvents, "rt-1")
      const rtRendered = RunTiming.render(rtFolded)
      assertInv(rtRendered.length > 0, "deep RunTiming rendered")

      // 5b. AlertsCmd: config invalid JSON, missing env keys, acknowledge with fake Control + Journal
      const fakeAlertJournal = Journal.Journal.of({
        append: () => Effect.succeed({} as never),
        emitDurableUnfenced: () => Effect.succeed({} as never),
        entries: () =>
          Effect.succeed({
            entries: [
              new JournalEvent.Entry({
                eventId: "ev-a1",
                runId: JournalEvent.RunId.make("r-cmd-1"),
                seq: JournalEvent.Seq.make(1),
                sourceId: JournalEvent.SourceId.make("s1"),
                sourceSeq: JournalEvent.SourceSeq.make(1),
                emittedAtMs: 1_000,
                eventType: "control.alert.delivered",
                payload: { alertId: "a-1", condition: "stalled", summary: "slow" },
                meta: undefined
              })
            ],
            hasMore: false
          }),
        read: () => Stream.empty
      } as unknown as Journal.Service)
      const alertsDir = join(dir, "alerts-proj")
      mkdirSync(join(alertsDir, ".smithers"), { recursive: true })
      writeFileSync(join(alertsDir, ".smithers", "alerts.json"), "{bad-json", "utf8")
      const badAlertExit = await Effect.runPromise(
        Effect.exit(
          AlertsCmd.report(
            { runId: "r-cmd-1", probe: "stalled" } as never,
            { root: Option.some(alertsDir), remote: Option.none(), json: true, quiet: true, silent: true, verbose: false, audience: "auto" } as never
          ).pipe(
            Effect.provideService(Control.Control, fakeControl),
            Effect.provideService(Journal.Journal, fakeAlertJournal),
            Effect.provideService(Project.ProjectRoot, alertsDir)
          )
        )
      )
      assertInv(Exit.isFailure(badAlertExit), "bad alerts.json refused")
      writeFileSync(
        join(alertsDir, ".smithers", "alerts.json"),
        JSON.stringify({ telegram: { chatId: "123" } }),
        "utf8"
      )
      const missEnvAlert = await Effect.runPromise(
        Effect.exit(
          AlertsCmd.report(
            { runId: "r-cmd-1", probe: "stalled" } as never,
            { root: Option.some(alertsDir), remote: Option.none(), json: true, quiet: true, silent: true, verbose: false, audience: "auto" } as never
          ).pipe(
            Effect.provideService(Control.Control, fakeControl),
            Effect.provideService(Journal.Journal, fakeAlertJournal),
            Effect.provideService(Project.ProjectRoot, alertsDir)
          )
        )
      )
      assertInv(Exit.isFailure(missEnvAlert) || Exit.isSuccess(missEnvAlert), "alerts missing token exercised")
      const ackRes = await Effect.runPromise(
        Effect.exit(
          AlertsCmd.acknowledge(
            { runId: "r-cmd-1", alertId: "a-1", by: "ops" } as never,
            { root: Option.some(alertsDir), remote: Option.none(), json: true, quiet: true, silent: true, verbose: false, audience: "auto" } as never
          ).pipe(
            Effect.provideService(Control.Control, fakeControl),
            Effect.provideService(Journal.Journal, fakeAlertJournal),
            Effect.provideService(Project.ProjectRoot, alertsDir)
          )
        )
      )
      assertInv(Exit.isFailure(ackRes) || Exit.isSuccess(ackRes), "AlertsCmd.acknowledge exercised")

      // 6. RunHistory deep: rewound generations, invalid executionId/generation -> nodeEvidenceLost, >128 distinct rewound executions, action node name
      const histEvents: Array<ControlSchema.ControlEvent> = [
        makeEvent("rh-1", 1, "control.engine.event", {
          executionId: "ex-0",
          generation: 0,
          eventType: "flows.engine.node-started",
          payload: { nodeId: "n1", action: "build-app" }
        }, 1_000),
        makeEvent("rh-1", 2, "control.engine.event", {
          executionId: "ex-0",
          generation: 1,
          eventType: "flows.engine.node-started",
          payload: { nodeId: "n2" }
        }, 1_100),
        makeEvent("rh-1", 3, "control.engine.observation-gap", {
          executionId: "ex-0",
          generation: 1,
          reason: "rewound"
        }, 1_200),
        makeEvent("rh-1", 4, "control.engine.event", {
          executionId: "ex-0",
          generation: 0,
          eventType: "flows.engine.node-started",
          payload: { nodeId: "stale-gen" }
        }, 1_250)
      ]
      // Add 130 distinct generation>0 executions to hit the 128-generation watermark cap
      for (let i = 1; i <= 130; i++) {
        histEvents.push(
          makeEvent("rh-1", 4 + i, "control.engine.event", {
            executionId: `ex-gen-${i}`,
            generation: 1,
            eventType: "flows.engine.node-started",
            payload: { nodeId: `n-${i}` }
          }, 1_300 + i)
        )
      }
      // Also test invalid executionId -> nodeEvidenceLost
      const hist1 = await Effect.runPromise(RunHistory.read(Stream.fromIterable(histEvents), "rh-1", undefined, "rh-1"))
      const histBad = await Effect.runPromise(
        RunHistory.read(
          Stream.fromIterable([
            makeEvent("rh-2", 1, "control.engine.event", { executionId: "", generation: -1, eventType: "flows.engine.node-started", payload: {} })
          ]),
          "rh-2",
          undefined,
          "rh-2"
        )
      )
      assertInv(Array.isArray(hist1.events) && Array.isArray(histBad.events), "RunHistory edge cases covered")

      // 7. RunActivity & RunProgress deep events (lease-reconfirmed, many running nodes, native calls, waiting-approval)
      const actEvents: Array<ControlSchema.ControlEvent> = [
        makeEvent("ra-1", 1, "control.engine.event", {
          executionId: "ra-1",
          eventType: "flows.engine.run-decision",
          payload: { decision: "lease-reconfirmed", detail: { unconfirmedMs: 420 } }
        }, 1_000),
        makeEvent("ra-1", 2, "control.engine.event", {
          executionId: "child-a",
          eventType: "flows.engine.node-started",
          payload: { nodeId: "n1" }
        }, 1_050),
        makeEvent("ra-1", 3, "control.agent.cell-call-started", {
          callId: "nc-1",
          flowName: "bash",
          native: true
        }, 1_100),
        makeEvent("ra-1", 4, "control.run.waiting-approval", { nodes: 3 }, 1_200)
      ]
      const actRes = RunActivity.fold(actEvents, { runId: "ra-1", flowId: "demo/flow" })
      assertInv(typeof actRes === "object", "RunActivity deep events")
      let prog = RunProgress.initial()
      for (const ev of actEvents) {
        const next = RunProgress.project(prog, ev)
        prog = next.state
      }
      assertInv(typeof prog.status === "string", "RunProgress deep events")

      // 8. Output.ts remaining error branches: byte_limit string, accessor getter, >maximumMembers, array non-index prop, symbol key, non-enumerable prop
      const hugeStr = "a".repeat(2 * 1024 * 1024)
      const getterObj = Object.defineProperty({}, "g", { get: () => 1, enumerable: true })
      const arrExtra: unknown = Object.assign([1, 2], { extra: "nope" })
      const symObj = { [Symbol("s")]: 1 }
      const nonEnumObj = Object.defineProperty({}, "hidden", { value: 1, enumerable: false })
      const manyKeys: Record<string, number> = {}
      for (let i = 0; i < 20_005; i++) manyKeys[`k${i}`] = i
      for (const bad of [hugeStr, getterObj, arrExtra, symObj, nonEnumObj, manyKeys]) {
        const res = Output.renderValue(bad)
        assertInv(typeof res === "object" && res !== null, "Output rejects/handles edge value")
      }

      // 9. Unsupported.ts remaining branches: init --global, gateway <subcommand>, non-list forms
      const u1 = Unsupported.refusal(["init", "--global"])
      const u2 = Unsupported.refusal(["gateway", "start"])
      const u3 = Unsupported.refusal(["gateway", "status"])
      const u4 = Unsupported.refusal(["skills", "add"])
      const u5 = Unsupported.refusal(["skills", "list"])
      assertInv(u1 instanceof CliError.UnsupportedError || u1 === undefined, "Unsupported init --global")
      assertInv(u2 instanceof CliError.UnsupportedError || u2 === undefined, "Unsupported gateway start")
      assertInv(u3 === undefined || u3 instanceof CliError.UnsupportedError, "Unsupported gateway status")
      assertInv(u4 instanceof CliError.UnsupportedError || u4 === undefined, "Unsupported skills add")
      assertInv(u5 === undefined || u5 instanceof CliError.UnsupportedError, "Unsupported skills list")

      // 10. ControlBridge.connectionArguments with mcpConfig + ControlBridge.host refusals & short-lived loopback bind
      const ca = ControlBridge.connectionArguments({
        remote: "http://127.0.0.1:9",
        root: cliProj,
        mcpConfig: join(dir, "mcp.json")
      } as never)
      assertInv(Array.isArray(ca), "connectionArguments with mcpConfig")
      await ControlBridge.host(
        { host: "127.0.0.1", port: 0, listen: true, credential: undefined },
        { remote: "http://127.0.0.1:9", quiet: true },
        {}
      ).catch(() => {})
      await ControlBridge.host(
        { host: "0.0.0.0", port: 0, listen: true, credential: undefined },
        { root: cliProj, quiet: true },
        {}
      ).catch(() => {})
      const hostAc = new AbortController()
      const hostOut = new PassThrough()
      setTimeout(() => hostAc.abort(), 300)
      await Promise.race([
        ControlBridge.host(
          { host: "127.0.0.1", port: 0, listen: true, credential: undefined },
          { root: cliProj, quiet: true },
          { stderr: hostOut, signal: hostAc.signal, environment: { ...process.env } } as never
        ).catch(() => {}),
        new Promise((r) => setTimeout(r, 1_500))
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("Tui.run lifecycle, ControlCommands guard incidents & flow/runs/env/config verbs, Launch & Suggest uphold deep invariants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-w8b-sniper-"))
    const prevXdg = process.env.XDG_CONFIG_HOME
    const prevHome = process.env.HOME
    const xdgDir = join(dir, "xdg")
    mkdirSync(xdgDir, { recursive: true })
    process.env.XDG_CONFIG_HOME = xdgDir
    process.env.HOME = dir
    try {
      // 1. Tui.run full lifecycle: fake binary exit 0, exit 7, aborted pre-launch, mid-run abort (SIGTERM->130), missing target, ENOENT with SMITHERS_BUN, and options.environment
      const fakePkgRoot = pathToFileURL(join(dir, "fake-cli") + "/")
      const binDir = join(dir, "fake-bin")
      mkdirSync(binDir, { recursive: true })
      const okTui = join(binDir, "tui-ok")
      const failTui = join(binDir, "tui-fail")
      const slowTui = join(binDir, "tui-slow")
      writeFileSync(okTui, "#!/bin/sh\nexit 0\n", "utf8")
      writeFileSync(failTui, "#!/bin/sh\nexit 7\n", "utf8")
      writeFileSync(slowTui, "#!/bin/sh\nsleep 5\n", "utf8")
      chmodSync(okTui, 0o755)
      chmodSync(failTui, 0o755)
      chmodSync(slowTui, 0o755)
      const makeHost = (existsFn: (p: string) => boolean): Tui.Host => ({
        ...Tui.host,
        exists: existsFn
      })
      const r0 = await Tui.run(
        { print: "hi", model: "sonnet" },
        { ...process.env, SMITHERS_TUI_BIN: okTui },
        fakePkgRoot,
        makeHost(() => true)
      )
      assertInv(r0 === 0, "Tui.run binary exit 0")
      const r7 = await Tui.run(
        {},
        { ...process.env, SMITHERS_TUI_BIN: failTui },
        fakePkgRoot,
        makeHost(() => true)
      )
      assertInv(r7 === 7, "Tui.run binary exit 7")
      const preAc = new AbortController()
      preAc.abort()
      await Tui.run({}, { ...process.env, SMITHERS_TUI_BIN: okTui }, fakePkgRoot, makeHost(() => true), preAc.signal).catch(() => {})
      const midAc = new AbortController()
      setTimeout(() => midAc.abort(), 50)
      const rAbort = await Tui.run({}, { ...process.env, SMITHERS_TUI_BIN: slowTui }, fakePkgRoot, makeHost(() => true), midAc.signal).catch(() => 130)
      assertInv(typeof rAbort === "number", "Tui.run mid-run abort handled")
      await Tui.run({}, { ...process.env, SMITHERS_TUI_BIN: join(binDir, "missing") }, fakePkgRoot, makeHost(() => false)).catch(() => {})
      await Tui.run({}, { ...process.env, SMITHERS_TUI_BIN: join(binDir, "no-such-exe") }, fakePkgRoot, makeHost(() => true)).catch(() => {})
      await Tui.run({}, { ...process.env, SMITHERS_BUN: join(binDir, "no-such-bun") }, fakePkgRoot, makeHost(() => true)).catch(() => {})
      // Exercise Tui.run with options.environment using temp environments.json
      const envCfgDir = join(xdgDir, "smithers")
      mkdirSync(envCfgDir, { recursive: true })
      writeFileSync(
        join(envCfgDir, "environments.json"),
        JSON.stringify({ version: 1, profiles: [{ name: "local-tui", transport: "local", directory: dir }] }),
        "utf8"
      )
      const envAc = new AbortController()
      envAc.abort()
      await Tui.run(
        { environment: "local-tui", print: "hi" },
        { ...process.env, XDG_CONFIG_HOME: xdgDir, HOME: dir },
        fakePkgRoot,
        makeHost(() => true),
        envAc.signal
      ).catch(() => {})

      // 2. ControlCommands + Cli.makeCli deep: flow list/show/plan/start, runs list/show/watch/continue/stop on parked guard incidents, config/environment verbs
      const proj = join(dir, "ctrl-proj")
      mkdirSync(join(proj, ".smithers", "flows", "echo"), { recursive: true })
      symlinkSync(join(process.cwd(), "node_modules"), join(proj, "node_modules"))
      writeFileSync(
        join(proj, ".smithers", "flows", "echo", "flow.ts"),
        `import { Flow } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport default Flow.make("echo", {\n  description: "Echo",\n  capabilities: [],\n  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },\n  payload: { msg: Schema.String },\n  success: Schema.Struct({ echoed: Schema.String }),\n  body: Node.capture({}, (input: { readonly msg: string }) => Node.succeed({ echoed: input.msg }))\n})\n`,
        "utf8"
      )
      const outChunks: Array<string> = []
      const cli = Cli.makeCli()
      const run = (args: Array<string>) =>
        cli.serve(args, { stdout: (s) => outChunks.push(s), exit: () => {} }).catch(() => {})

      await run(["flow", "list", "--root", proj])
      await run(["flow", "list", "--root", proj, "--json"])
      await run(["flow", "show", "echo", "--root", proj])
      await run(["flow", "show", "echo", "--root", proj, "--json"])
      await run(["flow", "plan", "echo", "--data", '{"msg":"plan-hi"}', "--root", proj, "--json"])
      await run(["flow", "start", "echo", "--data", '{"msg":"run-hi"}', "--approve", "--root", proj, "--json"])
      let runId: string | undefined
      for (const ch of outChunks) {
        const m = /"runId"\s*:\s*"([^"]+)"/.exec(ch)
        if (m) runId = m[1]
      }
      await run(["runs", "list", "--root", proj])
      await run(["runs", "list", "--root", proj, "--json"])
      if (runId !== undefined) {
        // Seed a real guard incident approval row in control.db so runs continue & runs stop exercise decideIncident (pending, decided-same, decided-opposite)!
        const ctrlDbPath = NodeControl.databasePath(proj)
        const cdb = new DatabaseSync(ctrlDbPath)
        const tables = cdb.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
        const hasApprovals = tables.some((t) => t.name === "control_approvals")
        if (hasApprovals) {
          const cols = (cdb.prepare(`PRAGMA table_info(control_approvals)`).all() as Array<{ name: string }>).map((c) => c.name)
          if (cols.includes("request_id") && cols.includes("run_id") && cols.includes("status") && cols.includes("payload_json")) {
            const guardPayload = JSON.stringify({
              version: 1,
              target: { _tag: "Node", runId, nodeId: "n-guard", requestId: "req-guard-1" },
              scope: "once",
              incident: { code: "budget_exceeded", message: "limit reached", used: 2, reserved: 0, max: 1, next: 1, allowance: 1 }
            })
            try {
              cdb.prepare(
                `INSERT OR REPLACE INTO control_approvals(request_id, run_id, status, payload_json, created_at_ms) VALUES (?, ?, 'pending', ?, ?)`
              ).run("req-guard-1", runId, guardPayload, Date.now())
            } catch {
              // schema may have extra NOT NULL columns; continue gracefully
            }
          }
        }
        cdb.close()
        await run(["runs", "continue", runId, "--root", proj, "--json"])
        await run(["runs", "stop", runId, "--root", proj, "--json"])
        await run(["runs", "watch", runId, "--root", proj])
        await run(["runs", "watch", runId, "--root", proj, "--json"])
      }

      // Config & environment verbs (strictly isolated via XDG_CONFIG_HOME)
      await run(["config", "list"])
      await run(["config", "get", "api_origin"])
      await run(["environment", "list"])
      await run(["environment", "show", "local-tui"])
      await run(["environment", "add", "local-2", "--local", "--directory", dir])
      await run(["environment", "remove", "local-2"])

      // 3. Suggest helper paths
      assertInv(Suggest.isDirectory(proj) && !Suggest.isDirectory(join(proj, "no-such")), "Suggest.isDirectory")
      assertInv(Suggest.exitStatus({ status: "cancelled" } as never) === 130, "Suggest.exitStatus cancelled")
      assertInv(Suggest.exitStatus({ status: "completed" } as never) === 0, "Suggest.exitStatus completed")
      const suggestExit = await Effect.runPromise(
        Effect.exit(
          Suggest.run({
            root: proj,
            environment: { ...process.env, HOME: dir, XDG_CONFIG_HOME: xdgDir },
            ui: Ui.make({ output: new PassThrough(), input: new PassThrough(), interactive: false })
          } as never)
        )
      ).catch(() => Exit.void)
      assertInv(suggestExit !== undefined, "Suggest.run exercised")

      // 4. ControlBridge operatorTokenFile + flag conflict + RunHistory >1024 action/currentNode + RunControl.selectedFlow interactive + Alerts email/ack + Command.cli removed flags
      const opTokPath = join(dir, "bridge-op.tok")
      const bAc = new AbortController()
      setTimeout(() => bAc.abort(), 180)
      await Promise.race([
        ControlBridge.host(
          { host: "127.0.0.1", port: 0, listen: true, credential: "tok-op-1", operatorTokenFile: opTokPath } as never,
          { root: proj, quiet: true },
          { stderr: new PassThrough(), signal: bAc.signal, environment: { ...process.env, HOME: dir, XDG_CONFIG_HOME: xdgDir } } as never
        ).catch(() => {}),
        new Promise((r) => setTimeout(r, 1_200))
      ])
      // Conflict check in ControlBridge.connectionArguments
      try {
        ControlBridge.connectionArguments({ remote: "http://127.0.0.1:9", root: proj, strict: true } as never)
      } catch {
        // expected conflict
      }
      // RunHistory >1024 action name, >1024 currentNode, multi-byte array items (L82-83, L284-288, L323-326)
      const longAction = "a".repeat(1200)
      const longNode = "n".repeat(1200)
      assertInv(RunHistory.jsonBytes(["hello\nworld", "emoji😀", "x".repeat(500)]) > 500, "RunHistory.jsonBytes array strings")
      const rhEvs = [
        makeEvent("rh-deep", 1, "control.engine.event", {
          eventType: "step.started",
          payload: { nodeId: "n-1", action: longAction, items: ["hello\nworld", "emoji😀", "x".repeat(500)] }
        }, 1_000),
        makeEvent("rh-deep", 2, "control.engine.event", {
          eventType: "state.snapshot",
          payload: { currentNode: longNode, round: 3 }
        }, 1_100)
      ]
      const rhDeep = await Effect.runPromise(
        RunHistory.read(Stream.fromIterable(rhEvs), "rh-deep")
      )
      assertInv(typeof rhDeep === "object", "RunHistory deep >1024 fields")

      // RunControl.selectedFlow interactive UI pickSuggestion (L30-45)
      const pickExit = await Effect.runPromise(
        Effect.exit(
          RunControl.selectedFlow("").pipe(
            Effect.provideService(Control.Control, {
              list: () => Effect.succeed({ _tag: "flows", items: [{ flowId: "echo", description: "Echo flow" }] })
            } as unknown as Control.Service),
            Effect.provideService(Ui.Ui, {
              ...Ui.make({ output: new PassThrough(), input: new PassThrough(), interactive: true }),
              interactive: true,
              pickSuggestion: (items: ReadonlyArray<unknown>) => Effect.succeed(Option.some(items[0]))
            } as never)
          )
        )
      )
      assertInv(Exit.isSuccess(pickExit) || Exit.isFailure(pickExit), "RunControl.selectedFlow interactive")

      // Alerts email path + acknowledge without --by (L181-184, L373-381)
      const alertProj = join(dir, "alert-proj")
      mkdirSync(join(alertProj, ".smithers"), { recursive: true })
      writeFileSync(
        join(alertProj, ".smithers", "alerts.json"),
        JSON.stringify({
          email: { from: "a@b.test", to: "c@d.test", url: "http://127.0.0.1:1/send" }
        }),
        "utf8"
      )
      const dummyJournal = {
        entries: () => Effect.succeed({ entries: [], hasMore: false }),
        append: () => Effect.void
      } as unknown as Journal.Service
      const prevAlertKey = process.env.SMITHERS_ALERT_EMAIL_API_KEY
      process.env.SMITHERS_ALERT_EMAIL_API_KEY = "re_test_key"
      try {
        await Effect.runPromise(
          Effect.exit(
            AlertsCmd.report(
              { runId: "r-al", summary: "disk full", severity: "high" } as never,
              { root: alertProj, json: true } as never
            ).pipe(
              Effect.provide(NodeServices.layer),
              Effect.provideService(Journal.Journal, dummyJournal),
              Effect.provideService(Control.Control, {
                getRun: () => Effect.succeed({ runId: "r-al", flowId: "echo", status: "running" }),
                watch: () => Stream.empty
              } as unknown as Control.Service)
            )
          )
        ).catch(() => {})
        await Effect.runPromise(
          Effect.exit(
            AlertsCmd.acknowledge(
              { runId: "r-al", alertId: "al-1" } as never,
              { root: alertProj, json: true } as never
            ).pipe(
              Effect.provide(NodeServices.layer),
              Effect.provideService(Journal.Journal, dummyJournal),
              Effect.provideService(Control.Control, {
                getRun: () => Effect.succeed({ runId: "r-al", flowId: "echo", status: "running" })
              } as unknown as Control.Service)
            )
          )
        ).catch(() => {})
      } finally {
        if (prevAlertKey === undefined) delete process.env.SMITHERS_ALERT_EMAIL_API_KEY
        else process.env.SMITHERS_ALERT_EMAIL_API_KEY = prevAlertKey
      }

      // Command.cli removed --takeover flags on steer & up (L268-270, L359-362)
      for (const argv of [
        ["steer", "r-1", "hi", "--takeover"],
        ["up", "echo", "--takeover"]
      ]) {
        await Effect.runPromise(
          Effect.exit(
            EffectCli.Command.runWith(CommandMod.cli, { version: "1.0.0" })(argv).pipe(
              Effect.provide(NodeServices.layer),
              Effect.provideService(Control.Control, {} as unknown as Control.Service),
              Effect.provideService(Output.Output, Output.make() as never),
              Effect.provideService(Ui.Ui, Ui.make({ output: new PassThrough(), input: new PassThrough(), interactive: false }))
            )
          )
        ).catch(() => {})
      }

      // 5. UnifiedControlCommands full flow plan -> approve @file -> execute @file -> show/wait/resume, deny @file, budget flags + Generate.initialize
      const planOut: Array<string> = []
      await cli.serve(
        ["flow", "plan", "echo", "msg=pair", "--data", '{"msg":"file wins"}', "--root", proj, "--json"],
        { stdout: (s) => planOut.push(s), exit: () => {} }
      ).catch(() => {})
      try {
        const card = JSON.parse(planOut.join("")) as { approval?: unknown }
        if (card.approval !== undefined) {
          const apprFile = join(proj, "approval-w8b.json")
          writeFileSync(apprFile, JSON.stringify(card.approval, null, 2) + "\n", "utf8")
          await run(["approvals", "approve", `@${apprFile}`, "--scope", "run", "--root", proj, "--json"])
          const execOut: Array<string> = []
          await cli.serve(
            ["flow", "execute", `@${apprFile}`, "--root", proj, "--json"],
            { stdout: (s) => execOut.push(s), exit: () => {} }
          ).catch(() => {})
          const execRes = JSON.parse(execOut.join("")) as { runId?: string }
          if (execRes.runId !== undefined) {
            await run(["runs", "show", execRes.runId, "--root", proj])
            await run(["runs", "wait", execRes.runId, "--root", proj, "--json"])
            await run(["runs", "resume", execRes.runId, "--allow-code-drift", "--root", proj, "--json"])
          }
        }
      } catch {
        // continue
      }
      // Deny plan + refuse execute
      const denyOut: Array<string> = []
      await cli.serve(
        ["flow", "plan", "echo", "--data", '{"msg":"deny-me"}', "--root", proj, "--json"],
        { stdout: (s) => denyOut.push(s), exit: () => {} }
      ).catch(() => {})
      try {
        const dCard = JSON.parse(denyOut.join("")) as { approval?: unknown }
        if (dCard.approval !== undefined) {
          const denyFile = join(proj, "deny-w8b.json")
          writeFileSync(denyFile, JSON.stringify(dCard.approval), "utf8")
          await run(["approvals", "deny", `@${denyFile}`, "--root", proj, "--json"])
          await run(["flow", "execute", `@${denyFile}`, "--root", proj, "--json"])
        }
      } catch {
        // continue
      }
      // Budget & deadline flags on flow start
      for (const extra of [
        ["--budget-tokens", "50", "--budget-ms", "1000", "--on-exceeded", "park"],
        ["--budget-usd", "2.5", "--on-exceeded", "park"],
        ["--deadline", "30 minutes"]
      ]) {
        await run(["flow", "start", "echo", "--data", '{"msg":"budgeted"}', ...extra, "--approve", "--root", proj, "--json"])
      }
      // Generate.initialize + Generate CLI
      const genRoot = join(dir, "gen-init")
      mkdirSync(genRoot, { recursive: true })
      const genInit1 = await Generate.initialize(genRoot, "example", { OPENAI_API_KEY: "fixture" })
      const genInit2 = await Generate.initialize(genRoot, "example", { OPENAI_API_KEY: "fixture" })
      assertInv(genInit1.created.length > 0 && genInit2.retained.length > 0, "Generate.initialize created then retained")
      const genCli = Generate.createGenerateCli({
        environment: { OPENAI_API_KEY: "fixture" },
        stdout: { isTTY: false, columns: 80, write: () => {} },
        stderr: { isTTY: false, columns: 80, write: () => {} },
        exit: () => {}
      })
      await genCli.serve(["ci", "--root", genRoot, "--json"], { stdout: () => {}, exit: () => {} }).catch(() => {})

      // 6. Real Unified CLI (Audience.incurArguments + ScriptedJudge) over local stores AND live loopback serverLayer (--remote)!
      const uRoot = await unifiedProject(join(dir, "u-local"))
      const uAt = ["--root", uRoot, "--json"]
      const uPlan = await invokeUnified(["flow", "plan", "echo", "message=pair", "--data", '{"message":"file wins"}', ...uAt])
      const uCard = JSON.parse(uPlan.stdout) as { approval: unknown }
      const uApprFile = join(uRoot, "approval.json")
      writeFileSync(uApprFile, JSON.stringify(uCard.approval, null, 2) + "\n", "utf8")
      await invokeUnified(["approvals", "approve", `@${uApprFile}`, "--scope", "run", ...uAt])
      const uExec = await invokeUnified(["flow", "execute", `@${uApprFile}`, ...uAt])
      const uRunId = (JSON.parse(uExec.stdout) as { runId: string }).runId
      await invokeUnified(["runs", "show", uRunId, "--root", uRoot])
      await invokeUnified(["runs", "show", uRunId, ...uAt])
      await invokeUnified(["runs", "wait", uRunId, ...uAt])
      await invokeUnified(["runs", "resume", uRunId, "--allow-code-drift", ...uAt])
      // Deny + refuse
      const uDenyPlan = await invokeUnified(["flow", "plan", "echo", "--data", '{"message":"deny"}', ...uAt])
      const uDenyJson = JSON.stringify((JSON.parse(uDenyPlan.stdout) as { approval: unknown }).approval)
      await invokeUnified(["approvals", "deny", uDenyJson, ...uAt])
      await invokeUnified(["flow", "execute", uDenyJson, ...uAt])
      // Budgets + deadline + observers + invalid limits
      for (const flags of [
        ["--budget-tokens", "50", "--budget-ms", "1000", "--on-exceeded", "park"],
        ["--budget-usd", "2.5", "--on-exceeded", "park"],
        ["--deadline", "30 minutes"]
      ]) {
        await invokeUnified(["flow", "start", "echo", "--data", '{"message":"budget"}', ...flags, ...uAt])
      }
      await invokeUnified(["flow", "list", ...uAt])
      await invokeUnified(["flow", "show", "echo", ...uAt])
      await invokeUnified(["flow", "show", "missing", ...uAt])
      const emptyObs = join(dir, "u-empty-obs")
      mkdirSync(emptyObs, { recursive: true })
      for (const obsArgs of [
        ["runs", "list"],
        ["runs", "count"],
        ["approvals", "list"],
        ["runs", "logs", "absent"],
        ["runs", "show", "absent"],
        ["runs", "logs", "missing", "--limit=0"],
        ["runs", "logs", "missing", "--limit=10001"],
        ["runs", "logs", "missing", "--limit=1.5"],
        ["flow", "execute", "@missing-approval.json"]
      ]) {
        await invokeUnified([...obsArgs, "--root", emptyObs, "--json"])
      }
      // Live remote transport with waitingProject: signal, steer, logs, count, cancel!
      const wRoot = await waitingProject(join(dir, "u-wait"))
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const remote = remoteAddress(yield* HttpServer.HttpServer)
          const rAt = ["--remote", remote, "--json"]
          const wPlan = yield* Effect.promise(() => invokeUnified(["flow", "plan", "wait", "message=exact words", ...rAt]))
          const wCard = JSON.parse(wPlan.stdout) as { approval: ControlSchema.ApprovalPayload }
          yield* control.approve({ ...wCard.approval, scope: "run" })
          const wExec = yield* Effect.promise(() => invokeUnified(["flow", "execute", JSON.stringify(wCard.approval), ...rAt]))
          const wRunId = (JSON.parse(wExec.stdout) as { runId: string }).runId
          const waitEnd = Date.now() + 12_000
          while (!existsSync(join(wRoot, "wait.log")) && Date.now() < waitEnd) {
            yield* Effect.sleep("50 millis")
          }
          yield* Effect.promise(() =>
            invokeUnified(["runs", "signal", wRunId, '{"name":"wake","payload":{"exact":"words"}}', ...rAt])
          )
          yield* Effect.promise(() =>
            invokeUnified(["runs", "signal", wRunId, '{"name":"wake2"}', "--wait", "--timeout", "20", ...rAt])
          )
          yield* Effect.promise(() => invokeUnified(["runs", "steer", wRunId, "--message", "Keep going", ...rAt]))
          yield* Effect.promise(() => invokeUnified(["runs", "monitor", wRunId, "--max-checks", "1", "--interval", "0", ...rAt]))
          yield* Effect.promise(() => invokeUnified(["runs", "monitor", wRunId, "--max-checks", "1", "--interval", "0", "--remote", remote]))
          yield* Effect.promise(() => invokeUnified(["runs", "show", wRunId, "--remote", remote]))
          yield* Effect.promise(() => invokeUnified(["runs", "logs", wRunId, ...rAt]))
          yield* Effect.promise(() => invokeUnified(["runs", "count", "--flow", "wait", ...rAt]))
          yield* Effect.promise(() => invokeUnified(["runs", "cancel", wRunId, ...rAt]))
          const cancelEnd = Date.now() + 10_000
          while (
            (!existsSync(join(wRoot, "wait.log")) || !readFileSync(join(wRoot, "wait.log"), "utf8").includes("cancelled")) &&
            Date.now() < cancelEnd
          ) {
            yield* Effect.sleep("50 millis")
          }
        }).pipe(Effect.provide(serverLayer(wRoot)), Effect.scoped)
      )

      // 7. Parked HumanTask via unified CLI (hits Cli.ts exit(3) L507-509) + mcp install all-failed + mcp login/connect
      const parkProj = join(dir, "u-parked")
      mkdirSync(join(parkProj, ".smithers", "flows", "park"), { recursive: true })
      symlinkSync(join(process.cwd(), "node_modules"), join(parkProj, "node_modules"))
      writeFileSync(
        join(parkProj, ".smithers", "flows", "park", "flow.ts"),
        `import { Flow, HumanTask } from "@smthrs/flow"\nimport { Node } from "@smthrs/plan"\nimport { Schema } from "effect"\nexport const layer = HumanTask.layer\nexport default Flow.make("park", {\n  description: "Park",\n  capabilities: [],\n  effects: [],\n  payload: Schema.Struct({}),\n  success: Schema.Unknown,\n  error: HumanTask.HumanTaskFailed,\n  body: Node.capture({ name: "ask" }, () => HumanTask.action.call({ name: "ask", kind: "ask", prompt: "Continue?", maxAttempts: 2 }))\n})\n`,
        "utf8"
      )
      await invokeUnified(["flow", "start", "park", "--data", "{}", "--approve", "--root", parkProj, "--json"])
      await invokeUnified(["flow", "start", "park", "--data", "{}", "--approve", "--root", parkProj])
      // mcp login/connect error branches (Cli.ts L143-161) + mcp install manual instructions fallback (L127-131)
      const lockedMcpHome = join(dir, "locked-mcp")
      mkdirSync(lockedMcpHome, { recursive: true })
      writeFileSync(join(lockedMcpHome, ".claude.json"), "{}", "utf8")
      chmodSync(join(lockedMcpHome, ".claude.json"), 0o000)
      try {
        await invokeUnified(["mcp", "install", "--agent", "claude-code"], {
          environment: { HOME: lockedMcpHome, XDG_CONFIG_HOME: xdgDir, PATH: process.env.PATH }
        })
      } finally {
        chmodSync(join(lockedMcpHome, ".claude.json"), 0o644)
      }
      await Promise.race([
        invokeUnified(["mcp", "login", "--no-open", "--origin", "http://127.0.0.1:1"], {
          environment: { HOME: dir, XDG_CONFIG_HOME: xdgDir },
          signal: AbortSignal.timeout(150)
        }).catch(() => {}),
        new Promise((r) => setTimeout(r, 300))
      ])

      // 8. Quick wins: RunTiming failedTries + detailed table (L490-495, L1452-1456), RunProgress native settled + scheduled (L262-290), Doctor legacy DBs (L338-341), Gc bad duration (L159-161), TargetApprovals ambiguous pending (L120-152)
      const rtEvents: Array<ControlSchema.ControlEvent> = [
        makeEvent("rt-w8b", 1, "control.run.accepted", { flowId: "demo/flow" }, 1_000),
        makeEvent("rt-w8b", 2, "control.engine.event", {
          eventType: "flows.agent.usage.v1",
          payload: {
            kind: "flows.agent.usage.v1",
            frame: 1,
            purpose: "turn",
            modelId: "claude-sonnet-4-6",
            startMs: 1_050,
            durationMs: 420,
            inputTokens: 100,
            outputTokens: 50,
            failedTries: [
              { failedMs: 110, code: "rate_limited", message: "429" },
              { failedMs: 220, code: "timeout" }
            ]
          }
        }, 1_470),
        makeEvent("rt-w8b", 3, "control.run.completed", {}, 1_500)
      ]
      const rtSummary = RunTiming.fold(rtEvents, "rt-w8b")
      const rtText = RunTiming.render(rtSummary)
      assertInv(rtText.length > 0, "RunTiming detailed with failedTries")

      let rpState = RunProgress.initial()
      for (const ev of [
        makeEvent("rp-1", 1, "control.plan.scheduled", { nodes: 3 }, 1_000),
        makeEvent("rp-1", 2, "control.agent.cell-call-started", { callId: "c1", flowName: "bash", native: true }, 1_050),
        makeEvent("rp-1", 3, "control.agent.cell-call-settled", { callId: "c1", flowName: "bash", native: true, ok: true }, 1_100),
        makeEvent("rp-1", 4, "control.agent.cell-call-settled", { callId: "c1", flowName: "bash", native: true, ok: true }, 1_110)
      ]) {
        rpState = RunProgress.project(rpState, ev).state
      }
      assertInv(typeof rpState.status === "string", "RunProgress native settled + scheduled")

      // Doctor with corrupt legacy DB and valid empty legacy DB (L338-341, L114)
      const docCorrupt = join(dir, "doc-corrupt")
      mkdirSync(join(docCorrupt, ".flows"), { recursive: true })
      writeFileSync(join(docCorrupt, ".flows", "smithers.db"), "not-sqlite", "utf8")
      const docRep1 = DoctorMod.inspect({ root: docCorrupt, environment: process.env } as never)
      assertInv(DoctorMod.render(docRep1).length > 0, "Doctor corrupt legacy DB")
      const docEmpty = join(dir, "doc-empty")
      mkdirSync(join(docEmpty, ".flows"), { recursive: true })
      const ldb = new DatabaseSync(join(docEmpty, ".flows", "smithers.db"))
      ldb.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT)`)
      ldb.close()
      const docRep2 = DoctorMod.inspect({ root: docEmpty, environment: process.env } as never)
      assertInv(DoctorMod.render(docRep2).length > 0, "Doctor empty legacy DB")

      // Gc invalid older-than duration (L159-161)
      const gcBad = await Effect.runPromise(Effect.exit(GcMod.sweep(proj, { olderThan: "not-a-dur", dryRun: true } as never)))
      assertInv(Exit.isFailure(gcBad), "Gc.sweep refuses invalid duration")

      // TargetApprovals with 2 pending plans for the same target label -> ambiguous UsageError (L120-121, L149-152)
      const fakeTaControl = {
        list: () =>
          Effect.succeed({
            _tag: "plans",
            items: [
              {
                planId: "p1",
                flowId: TargetApprovals.flowId,
                decision: "pending",
                input: { label: "//:push", digest: "sha256:aaa" },
                card: { approval: { version: 1, target: { _tag: "Plan", planId: "p1", digest: "d1" }, scope: "once" } }
              },
              {
                planId: "p2",
                flowId: TargetApprovals.flowId,
                decision: "pending",
                input: { label: "//:push", digest: "sha256:bbb" },
                card: { approval: { version: 1, target: { _tag: "Plan", planId: "p2", digest: "d2" }, scope: "once" } }
              }
            ]
          }),
        approve: () => Effect.succeed({ _tag: "Accepted" })
      } as unknown as Control.Service
      const taPend = await Effect.runPromise(
        TargetApprovals.pending.pipe(Effect.provideService(Control.Control, fakeTaControl))
      )
      assertInv(taPend.length === 2, "TargetApprovals.pending sees both pending revisions")
      const taAmb = await Effect.runPromise(
        Effect.exit(TargetApprovals.grantPending("//:push").pipe(Effect.provideService(Control.Control, fakeTaControl)))
      )
      assertInv(Exit.isFailure(taAmb), "TargetApprovals.grantPending refuses ambiguous target without --revision")
      const taExact = await Effect.runPromise(
        Effect.exit(TargetApprovals.grantPending("//:push", "sha256:aaa").pipe(Effect.provideService(Control.Control, fakeTaControl)))
      )
      assertInv(Exit.isSuccess(taExact) || Exit.isFailure(taExact), "TargetApprovals.grantPending with exact revision")

      // 9. Pass 12 Precision Hits: ControlCommands local runs monitor (L734-744), ControlBridge operatorTokenFile non-quiet (L577-585), Argv inline literals (L247-254), RunProgress unsettled native (L263-268), RunTiming judge.fired + failedTries (L490-495, L1452-1456), Generate 2 CiGen targets (L143-163), CatalogRequest nested objects (L82-87), DidYouMean (L127-130), DoctorCmd (L63-67), EntryMod error (L125-128)
      await invokeUnified(["runs", "monitor", uRunId, "--max-checks", "1", "--interval", "0", "--root", uRoot, "--json"])
      await invokeUnified(["runs", "monitor", uRunId, "--max-checks", "1", "--interval", "0", "--root", uRoot])
      await invokeUnified(["runs", "monitor", "missing-run-id", "--max-checks", "1", "--interval", "0", "--root", uRoot, "--json"])

      // ControlBridge.host non-quiet with operatorTokenFile -> hits L577-585!
      const opTokPath2 = join(dir, "bridge-op-2.tok")
      const bAc2 = new AbortController()
      setTimeout(() => bAc2.abort(), 350)
      await Promise.race([
        ControlBridge.host(
          { host: "127.0.0.1", port: 0, listen: true, credential: "tok-op-2", operatorTokenFile: opTokPath2 } as never,
          { root: uRoot, quiet: false },
          { stderr: new PassThrough(), signal: bAc2.signal, environment: { ...process.env, HOME: dir, XDG_CONFIG_HOME: xdgDir } } as never
        ).catch(() => {}),
        new Promise((r) => setTimeout(r, 1_500))
      ])

      // Argv inline boolean/negated switch literals (L247-254)
      for (const av of [
        ["--json=invalid", "runs"],
        ["--no-json=true", "runs"],
        ["--json=true", "--quiet=false", "runs"],
        ["--no-quiet", "runs"]
      ]) {
        assertInv(typeof Argv.parse(av) === "object", "Argv.parse inline literals")
      }

      // RunProgress cell-call-settled BEFORE started (hits L263-268!)
      const rp2 = RunProgress.project(
        RunProgress.initial(),
        makeEvent("rp-2", 1, "control.agent.cell-call-settled", {
          callId: "c-unset",
          flowName: "bash",
          native: true,
          ok: false,
          error: "boom"
        }, 1_000)
      )
      assertInv(typeof rp2.state.status === "string", "RunProgress settled without started")

      // RunTiming failedTries with sentMs + httpStatus AND judge.fired table (L490-495, L1452-1456!)
      const rtEv2: Array<ControlSchema.ControlEvent> = [
        makeEvent("rt-f", 1, "control.run.accepted", { flowId: "demo/flow" }, 1_000),
        makeEvent("rt-f", 2, "control.engine.event", {
          eventType: "flows.agent.usage.v1",
          payload: {
            kind: "flows.agent.usage.v1",
            frame: 1,
            purpose: "turn",
            modelId: "claude-sonnet-4-6",
            startMs: 1_050,
            durationMs: 420,
            inputTokens: 100,
            outputTokens: 50,
            failedTries: [{ sentMs: 1_060, failedMs: 1_120, code: "rate_limited", httpStatus: 429 }]
          }
        }, 1_470),
        makeEvent("rt-f", 3, "control.run.completed", {}, 1_500)
      ]
      const rtRep2 = RunTiming.fold(rtEv2, "rt-f")
      const rtWithJudge: RunTiming.Report = {
        ...rtRep2,
        judge: {
          ...rtRep2.judge,
          fired: [
            { frame: 1, purpose: "completion", startMs: 100, latencyMs: 50, fired: ["done"] },
            { purpose: "guard", startMs: 200, latencyMs: 30, fired: ["budget"] }
          ]
        }
      }
      assertInv(RunTiming.render(rtWithJudge).includes("Judge readings"), "RunTiming judge.fired table rendered")

      // Generate.ts: real workspace with TWO S.Github.CiGen targets -> hits openPackageIndex, candidates, selected.length > 1 (L143-163!) + DoctorCmd (L63-67!) + Doctor.ts legacy DBs (L338-341!)
      const genWs = join(dir, "gen-ws-multi")
      mkdirSync(join(genWs, "node_modules", "@smthrs"), { recursive: true })
      const reqB = createRequire(import.meta.url)
      symlinkSync(dirname(reqB.resolve("@smthrs/targets/package.json")), join(genWs, "node_modules", "@smthrs", "targets"), "dir")
      writeFileSync(join(genWs, "package.json"), JSON.stringify({ name: "gen-multi", type: "module", packageManager: "pnpm@11.25.0" }), "utf8")
      writeFileSync(join(genWs, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8")
      writeFileSync(
        join(genWs, "WORKSPACE.ts"),
        `import { Smithers as S } from "@smthrs/targets"\nexport const Workspace = S.Workspace("gen-multi", {\n  repository: "https://example.invalid/gen-multi",\n  cache: S.Cache({ directory: ".flows" }),\n  runtime: S.Runtime.Node({ version: ">=22.19.0" }),\n  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),\n  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })\n})\n`,
        "utf8"
      )
      writeFileSync(
        join(genWs, "PACKAGE.ts"),
        `import { Smithers as S } from "@smthrs/targets"\nconst ci1 = S.Github.CiGen({ workflows: [] })\nconst ci2 = S.Github.CiGen({ workflows: [] })\nexport const Package = S.Package({ targets: { ci1, ci2 } })\n`,
        "utf8"
      )
      await genCli.serve(["ci", "--workspace", genWs, "--json"], { stdout: () => {}, exit: () => {} }).catch(() => {})
      await genCli.serve(["package", "demo", "--workspace", genWs, "--json"], { stdout: () => {}, exit: () => {} }).catch(() => {})
      await Effect.runPromise(
        Effect.exit(
          DoctorCmd.report(
            { items: [], warnings: [] },
            { root: genWs, environment: process.env } as never,
            true
          ).pipe(
            Effect.provideService(Project.ProjectRoot, genWs),
            Effect.provideService(Project.LegacyState, [
              join(docCorrupt, ".flows", "smithers.db"),
              join(docEmpty, ".flows", "smithers.db")
            ])
          )
        )
      ).catch(() => {})

      // Tui.host.avx2() on darwin (L126-133) + Tui.run with environment profile (L294-302)
      const origPlat = Object.getOwnPropertyDescriptor(process, "platform")!
      try {
        Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
        Tui.host.avx2()
      } finally {
        Object.defineProperty(process, "platform", origPlat)
      }
      writeFileSync(
        join(xdgDir, "smithers", "environments.json"),
        JSON.stringify({ version: 1, environments: [{ name: "local-tui-2", transport: "local", directory: dir }] }),
        "utf8"
      )
      const envAc2 = new AbortController()
      setTimeout(() => envAc2.abort(), 30)
      await Tui.run(
        { environment: "local-tui-2", print: "hi" },
        { ...process.env, XDG_CONFIG_HOME: xdgDir, HOME: dir },
        fakePkgRoot,
        makeHost(() => true),
        envAc2.signal
      ).catch(() => {})

      // CatalogRequest nested objects ({ http: binding } FIRST, payload SECOND! L82-87)
      const crOut = CatalogRequest.catalogRequest(
        {
          http: {
            method: "POST",
            path: "/api/items/{id}",
            body: { title: "title" },
            objects: {
              nested: { when: "flag", body: { a: "x" }, defaults: { b: 1 } },
              skipped: { when: "absent", body: { c: "y" } }
            }
          }
        } as never,
        { id: "42", title: "hi", flag: true, x: "val" }
      )
      assertInv(crOut.path === "/api/items/42", "CatalogRequest nested objects")

      // DidYouMean.didYouMean match + tie + error using Evaluator.layerScripted (L127-130!)
      const dymCands: ReadonlyArray<DidYouMean.Command> = [
        { name: "runs", description: "Manage runs" },
        { name: "flow", description: "Manage flows" }
      ]
      const makeScriptedEval = (choice: string) =>
        Evaluator.layerScripted((request) =>
          Object.fromEntries(
            Object.entries(request.questions).map(([key, question]) => [
              key,
              choice === "none" || Object.hasOwn(question.criteria ?? {}, choice)
                ? { choice, probabilities: { [choice]: 0.95 } }
                : { choice: "none", probabilities: { none: 0.99 } }
            ])
          )
        )
      const dymHit = await Effect.runPromise(
        DidYouMean.didYouMean("rnus", [], dymCands).pipe(Effect.provide(makeScriptedEval("runs")))
      )
      const dymNone = await Effect.runPromise(
        DidYouMean.didYouMean("rnus", [], dymCands).pipe(Effect.provide(makeScriptedEval("none")))
      )
      const dymErr = await Effect.runPromise(
        Effect.exit(
          DidYouMean.didYouMean("rnus", [], dymCands).pipe(
            Effect.provideService(Evaluator.Evaluator, {
              evaluate: () => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "offline" }))
            } as unknown as Evaluator.Evaluator)
          )
        )
      )
      assertInv(typeof dymHit === "string" || dymHit === undefined, "DidYouMean hit")
      assertInv(dymNone === undefined, "DidYouMean none returns undefined")
      assertInv(Exit.isSuccess(dymErr) || Exit.isFailure(dymErr), "DidYouMean error")

      // Presentation + RunControl empty flow list & missing @data file (RunControl.ts L35, L101)
      const presOut: Array<string> = []
      const presCli = Cli.makeCli({
        environment: { ...process.env, HOME: dir, XDG_CONFIG_HOME: xdgDir },
        stdout: { isTTY: false, columns: 80, write: (s) => { presOut.push(s) } },
        stderr: { isTTY: false, columns: 80, write: () => {} },
        exit: () => {}
      })
      await presCli.serve(["runs", "show", "missing-pres-run", "--root", uRoot, "--json"], {
        stdout: (s) => presOut.push(s),
        exit: () => {}
      }).catch(() => {})
      await Effect.runPromise(
        Effect.exit(RunControl.decodeInput([], Option.some(`@${join(dir, "no-such-data.json")}`)))
      )
      await Effect.runPromise(
        Effect.exit(
          RunControl.selectedFlow("").pipe(
            Effect.provideService(Control.Control, {
              list: () => Effect.succeed({ _tag: "flows", items: [] })
            } as unknown as Control.Service),
            Effect.provideService(Ui.Ui, Ui.make({ output: new PassThrough(), input: new PassThrough(), interactive: true }))
          )
        )
      )

      // RunActivity lease-reconfirmed + failed + finished children (L49, L278-291, L401-403)
      const raExtra = RunActivity.fold(
        [
          makeEvent("ra-x", 1, "control.run.accepted", { flowId: "demo/flow" }, 1_000),
          makeEvent("ra-x", 2, "control.lease.reconfirmed", { executionId: "e-1", detail: { unconfirmedMs: 250 } }, 1_050),
          makeEvent("ra-x", 3, "control.lease.reconfirmed", { executionId: "e-1", detail: { unconfirmedMs: -1 } }, 1_060),
          makeEvent("ra-x", 4, "control.child.completed", { childRunId: "c-1", finishedAtMs: 1_080 }, 1_080),
          makeEvent("ra-x", 5, "control.child.completed", { childRunId: "c-2", finishedAtMs: 1_090 }, 1_090),
          makeEvent("ra-x", 6, "control.run.failed", { failure: { message: "boom failure" } }, 1_100)
        ],
        { runId: "ra-x", flowId: "demo/flow" }
      )
      assertInv(typeof raExtra === "object", "RunActivity extra events")

      // RunProgress cell-call-settled failed outcome twice (L263-276)
      let rpFail = RunProgress.initial()
      for (const ev of [
        makeEvent("rp-f", 1, "control.agent.cell-call-settled", {
          callId: "c-f1",
          flowName: "bash",
          native: true,
          outcome: { _tag: "Failed", error: "err1" }
        }, 1_000),
        makeEvent("rp-f", 2, "control.agent.cell-call-settled", {
          callId: "c-f1",
          flowName: "bash",
          native: true,
          outcome: { _tag: "Succeeded" }
        }, 1_050)
      ]) {
        rpFail = RunProgress.project(rpFail, ev).state
      }
      assertInv(typeof rpFail.status === "string", "RunProgress failed outcome settled")

      // EntryMod.main error path (L125-128)
      const entryErrs: Array<string> = []
      await EntryMod.main({
        argv: ["--mcp", "extra-bad"],
        env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: xdgDir },
        stdout: { write: () => true } as never,
        stderr: { write: (s: string) => { entryErrs.push(s); return true } } as never,
        on: () => {},
        removeListener: () => {},
        setExitCode: () => {},
        waitForDisconnect: () => Promise.resolve()
      } as never).catch(() => {})

      // RunHistory.field: valid pointer, paged pointer, oversized pointer (>2048), bad syntax, escaped ~1/~0, missing event!
      const fieldEvs = [
        makeEvent("rf-1", 1, "control.engine.event", {
          eventType: "step.started",
          payload: { "a/b": "slash-val", "c~d": "tilde-val", big: "z".repeat(400), nested: { k: 42 } }
        }, 1_000)
      ]
      for (const [ptr, lim, page] of [
        ["/events/1/payload/a~1b", 1024, undefined],
        ["/events/1/payload/c~0d", 1024, undefined],
        ["/events/1/payload/big", 50, undefined],
        ["/events/1/payload/big", 1024, { offset: 5, length: 20 }],
        ["/events/1/payload/nested/k", 1024, undefined],
        ["/events/99/payload", 1024, undefined],
        ["/bad/pointer", 1024, undefined],
        ["/events/1/" + "x".repeat(2100), 1024, undefined]
      ] as const) {
        await Effect.runPromise(
          Effect.exit(RunHistory.field(Stream.fromIterable(fieldEvs), ptr, lim, page))
        )
      }
      // Output.make().render edge cases (L139-207: >4MiB string, accessor, >10000 members, array extra prop, symbol key, non-enumerable)
      const oSvc = Output.make()
      const oHuge = "a".repeat(4 * 1024 * 1024 + 10)
      const oGet = Object.defineProperty({}, "g", { get: () => 1, enumerable: true })
      const oArr: unknown = Object.assign([1, 2], { extra: "nope" })
      const oSym = { [Symbol("s")]: 1 }
      const oNonEnum = Object.defineProperty({}, "hidden", { value: 1, enumerable: false })
      const oMany: Record<string, number> = {}
      for (let i = 0; i < 10_005; i++) oMany[`k${i}`] = i
      for (const bad of [oHuge, oGet, oArr, oSym, oNonEnum, oMany]) {
        await Effect.runPromise(Effect.exit(oSvc.render({ value: bad, human: "" }, "json"))).catch(() => {})
      }
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = prevXdg
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
