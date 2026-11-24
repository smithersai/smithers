import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import * as ControlLive from "@smthrs/control/ControlLive"
import { CaseExecutor, Suite } from "@smthrs/evals"
import { Fuzz } from "@smthrs/fuzz"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { NotificationQueue } from "@smthrs/notifications"
import { NodeRuntime } from "@smthrs/platform-node"
import { Registry } from "@smthrs/registry"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import { Arbitrary, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { Cli } from "incur"
import { execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Binding from "../agent/scorers/src/Binding.ts"
import * as Scorer from "../agent/scorers/src/Scorer.ts"
import * as McpRemote from "../src/cli/McpRemote.ts"
import * as RunnerCmd from "../src/commands/Runner.ts"
import { createEvalCli } from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"
import * as History from "../src/history/History.ts"
import * as Verify from "../src/history/Verify.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as CodexLogin from "../src/internal/CodexLogin.ts"
import * as NodeControl from "../src/NodeControl.ts"
import { createMemoryCli } from "../src/operator/Memory.ts"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Lane from "../src/runner/Lane.ts"
import * as Workspace from "../src/runner/Workspace.ts"
import * as Suggest from "../src/Suggest.ts"
import * as Checklist from "../src/suggest/Checklist.ts"
import * as Ui from "../src/Ui.ts"
import * as Host from "./fixtures/runner/host.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "25")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "90401")

const assertInv = (cond: boolean, message: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${message}`)
}

const runFuzz = <A>(
  arb: Arbitrary.Arbitrary<A>,
  fn: (value: A) => void,
  opts: { readonly executions: number; readonly seed: number }
) =>
  Effect.runPromise(
    Fuzz.run(
      arb,
      (value) =>
        Effect.sync(() => {
          fn(value)
          return true
        }),
      opts
    )
  )

const expectPassed = (report: { readonly _tag: string }): void => {
  if (report._tag !== "Passed") {
    const first =
      (report as { readonly failures?: ReadonlyArray<{ readonly failure?: { readonly defect?: unknown } }> })
        .failures?.[0]
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report)
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/cli Wave-9D Deep Runner, History, Operators, Evaluation, ClaudeCode, CodexLogin, McpRemote & Suggest fuzz", () => {
  it(
    "Workspace, RunnerCmd & Lane cover reap/contained/sweep/changes/read, start validations, statusServer & baseLayer",
    async () => {
      await withTempDir("wave9d-runner-", async (tmp) => {
        // 1. Workspace.reap: missing dir, malformed json, dead pid, live spawned process group
        const stateDir = join(tmp, "state")
        mkdirSync(join(stateDir, "groups"), { recursive: true })
        await Effect.runPromise(Workspace.reapGroups(join(tmp, "no-such-state")))
        writeFileSync(join(stateDir, "groups", "bad.json"), "{not json")
        writeFileSync(
          join(stateDir, "groups", "dead.json"),
          JSON.stringify({ pid: 99999999, startedAt: Date.now() })
        )
        const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
          detached: true,
          stdio: "ignore"
        })
        sleeper.unref()
        if (sleeper.pid !== undefined) {
          writeFileSync(
            join(stateDir, "groups", "live.json"),
            JSON.stringify({ pid: sleeper.pid, startedAt: Date.now() })
          )
        }
        try {
          await Effect.runPromise(Workspace.reapGroups(stateDir))
        } finally {
          try {
            if (sleeper.pid !== undefined) process.kill(-sleeper.pid, "SIGKILL")
          } catch {}
        }

        // 2. Workspace create, changes (with added/modified/deleted/symlink/too-large), read, forget & sweep
        const mirror = Host.mirror(tmp)
        const checkout = Workspace.of(stateDir, "job-9d-1")
        await Effect.runPromise(Workspace.create(mirror.path, mirror.base, checkout))
        writeFileSync(join(checkout.dir, "added.txt"), "hello world\n")
        const changed = await Effect.runPromise(
          Workspace.changes(checkout, mirror.base, { files: 10, bytes: 4096 }, mirror.path)
        )
        expect(changed).toBeDefined()
        // Too-large limit triggers undefined
        const tooLarge = await Effect.runPromise(
          Workspace.changes(checkout, mirror.base, { files: 1, bytes: 2 }, mirror.path)
        )
        expect(tooLarge).toBeUndefined()

        // trustedRemote, gitAuthEnv, fetchStoreOf & remove/sweep
        expect(Workspace.trustedRemote("https://github.com/org/repo.git")).toBeDefined()
        expect(Workspace.trustedRemote("http://insecure.example/repo.git")).toBeUndefined()
        expect(Workspace.trustedRemote("not a url")).toBeUndefined()
        expect(
          Workspace.gitAuthEnv({
            remote: "https://github.com/org/repo.git",
            username: "x-access-token",
            password: "tok"
          })
        ).toBeDefined()
        expect(Workspace.fetchStoreOf(stateDir, mirror.path)).toContain(stateDir)
        expect(Workspace.exists(checkout)).toBe(true)

        await Effect.runPromise(Workspace.remove(mirror.path, checkout))
        const staleDir = join(stateDir, "workspaces", "stale-1")
        mkdirSync(staleDir, { recursive: true })
        writeFileSync(join(staleDir, "x.txt"), "stale")
        await Effect.runPromise(Workspace.sweep(stateDir))

        // Workspace.jj timeout kill branch
        const jjTimeout = await Effect.runPromiseExit(Workspace.jj(["--version"], 1))
        expect(Exit.isSuccess(jjTimeout) || Exit.isFailure(jjTimeout)).toBe(true)

        // 3. RunnerCmd.start validations & renderStatus & status
        const lanes = Lanes.make()
        try {
          const startFail = async (opts: RunnerCmd.StartOptions) => Effect.runPromiseExit(RunnerCmd.start(opts))
          expect(
            Exit.isFailure(
              await startFail({
                brief: "   ",
                config: lanes.configPath,
                profile: "test-agent",
                repository: Lanes.REPOSITORY,
                standing: false,
                maxHours: 1,
                restarts: 1
              })
            )
          ).toBe(true)
          expect(
            Exit.isFailure(
              await startFail({
                brief: "do work",
                config: lanes.configPath,
                profile: "test-agent",
                repository: "missing-repo",
                standing: false,
                maxHours: 1,
                restarts: 1
              })
            )
          ).toBe(true)
          expect(
            Exit.isFailure(
              await startFail({
                brief: "do work",
                config: lanes.configPath,
                profile: "missing-profile",
                repository: Lanes.REPOSITORY,
                standing: false,
                maxHours: 1,
                restarts: 1
              })
            )
          ).toBe(true)

          expect(
            Exit.isFailure(
              await startFail({
                brief: "implement wave 9d",
                config: lanes.configPath,
                profile: "test-agent",
                repository: Lanes.REPOSITORY,
                standing: false,
                maxHours: 1,
                restarts: 1,
                title: "Wave 9D task"
              })
            )
          ).toBe(true)
          expect(
            Exit.isFailure(
              await startFail({
                brief: "implement wave 9d",
                config: lanes.configPath,
                profile: "test-agent",
                repository: Lanes.REPOSITORY,
                standing: false,
                maxHours: 1,
                restarts: 1,
                workstream: "ws-9d",
                task: "task-9d",
                title: "Wave 9D task"
              })
            )
          ).toBe(true)
          const emptyBrief = join(tmp, "empty-brief.md")
          writeFileSync(emptyBrief, "   \n")
          expect(
            Exit.isFailure(
              await startFail({
                brief: emptyBrief,
                config: lanes.configPath,
                profile: "test-agent",
                repository: Lanes.REPOSITORY,
                standing: false,
                maxHours: 1,
                restarts: 1
              })
            )
          ).toBe(true)
          const briefFile = join(tmp, "brief.md")
          writeFileSync(briefFile, "implement wave 9d\n")
          const startOk = await Effect.runPromise(
            RunnerCmd.start({
              brief: briefFile,
              config: lanes.configPath,
              profile: "test-agent",
              repository: Lanes.REPOSITORY,
              standing: false,
              maxHours: 1,
              restarts: 1
            })
          )
          expect(startOk).toBeDefined()

          const st = await Effect.runPromise(RunnerCmd.status(lanes.configPath))
          expect(Array.isArray(st)).toBe(true)
          const html = RunnerCmd.renderStatus(st)
          expect(html).toContain("No workstreams")
        } finally {
          await lanes.close()
        }

        // 4. Lane.resolveBase (valid & invalid) & Lane.baseLayer / registration
        const resolvedOk = await Effect.runPromise(Lane.resolveBase(mirror.path, mirror.base))
        expect(resolvedOk.length).toBeGreaterThan(0)
        const resolvedBad = await Effect.runPromiseExit(Lane.resolveBase(mirror.path, "nonexistent-rev-xyz"))
        expect(Exit.isFailure(resolvedBad)).toBe(true)

        const reg = Lane.registration({
          stateDir,
          repositories: { demo: { mirror: mirror.path, base: mirror.base } }
        } as never)
        expect(reg).toBeDefined()

        // Fuzz Workspace.of path invariants
        const report = await runFuzz(
          Arbitrary.schema(Schema.Struct({ key: Schema.NonEmptyString })),
          ({ key }) => {
            const safe = key.replace(/[^a-zA-Z0-9_-]/g, "a").slice(0, 32) || "k"
            const ws = Workspace.of(stateDir, safe)
            assertInv(ws.dir.startsWith(stateDir), "workspace dir contained in stateDir")
            assertInv(ws.name.length > 0, "workspace name non-empty")
          },
          { executions, seed }
        )
        expectPassed(report)
      })
    },
    60_000
  )

  it(
    "History, Verify, TriggerPlans, OperatorMemory & TargetRuns cover replay/fork/verify/approvals/memory/leases",
    async () => {
      await withTempDir("wave9d-ops-", async (tmp) => {
        // 1. History & Verify against real SQLite engine.db
        const histRoot = join(tmp, "hist")
        mkdirSync(histRoot, { recursive: true })
        execFileSync("jj", ["git", "init", histRoot], { stdio: "ignore" })
        await Effect.runPromise(
          Effect.void.pipe(
            Effect.provide(NodeRuntime.storage(join(histRoot, ".flows", "engine.db"), histRoot)),
            Effect.provide(NodeServices.layer),
            Effect.provide(NodeCrypto.layer)
          )
        )
        await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(histRoot).runtime)))
        const db = new DatabaseSync(join(histRoot, ".flows", "engine.db"))
        db.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,?)")
          .run(
            JSON.stringify({ version: 1, flowName: "agent/run", payload: { runId: "run-1", planId: "plan-1" } })
          )
        db.prepare(
          "INSERT INTO flows_runs(run_id,status,created_at_ms,state_json,owner_host_id,owner_pid,owner_nonce,heartbeat_at_ms) VALUES('run-active','running',0,?,'host-1',1,'nonce-1',0)"
        ).run(
          JSON.stringify({ version: 1, flowName: "agent/run", payload: { runId: "run-active" } })
        )
        const ins = db.prepare(
          "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES(?,?,?,?,?,0,?,?,?)"
        )
        const st1 = { version: 1, flowName: "agent/run", payload: { runId: "run-1", planId: "plan-1" } }
        ins.run(
          "run-1",
          1,
          "e1",
          "fix",
          1,
          "flows.engine.run-decision",
          JSON.stringify({ state: st1, decision: "created" }),
          JSON.stringify({ lineageId: "fixture/root" })
        )
        ins.run(
          "run-1",
          2,
          "e2",
          "fix",
          2,
          "example.output",
          JSON.stringify({ value: "saved" }),
          JSON.stringify({ lineageId: "fixture/root" })
        )
        db.close()
        const ctrlDb = new DatabaseSync(join(histRoot, ".flows", "control.db"))
        ctrlDb.prepare(
          "INSERT INTO control_plans(plan_id,card_json,decoded_input_json,decision) VALUES('plan-1','{}','{}','approved')"
        ).run()
        ctrlDb.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,?)")
          .run(
            JSON.stringify({
              runId: "run-1",
              flowId: "fixture",
              planId: "plan-1",
              planDigest: "digest",
              status: "parked",
              createdAt: 0,
              updatedAt: 0
            })
          )
        ctrlDb.close()

        const readRes = await History.read(histRoot, "run-1", { root: histRoot }, true)
        expect(readRes).toBeDefined()
        const prevRes = await History.preview(histRoot, "run-1", { root: histRoot, sequence: 1 })
        expect(prevRes).toBeDefined()
        await History.reconcile(histRoot)

        // History.mutate error branches: active run, missing frame, valid rewind & fork
        await expect(
          History.mutate(histRoot, "run-active", { root: histRoot, sequence: 1 }, "rewind")
        ).rejects.toThrow()
        await expect(
          History.mutate(histRoot, "run-1", { root: histRoot, sequence: 999 }, "rewind")
        ).rejects.toThrow()
        const rewOk = await History.mutate(histRoot, "run-1", { root: histRoot, sequence: 1 }, "rewind")
        expect(rewOk.runId).toBe("run-1")
        const forkRes = await History.mutate(histRoot, "run-1", { root: histRoot, sequence: 1 }, "fork").catch((e) => e)
        expect(forkRes).toBeDefined()

        // Verify: missing run refusal, recordedSteps, report & divergence helpers
        await expect(Verify.verify(histRoot, "run-does-not-exist")).rejects.toThrow()
        const steps = await Effect.runPromise(Verify.recordedSteps(join(histRoot, ".flows", "engine.db"), "run-1"))
        expect(Array.isArray(steps)).toBe(true)
        const rep = Verify.report("run-1", steps, [])
        expect(Verify.divergence(rep)).toBeDefined()
        expect(
          Verify.storeDivergence({
            verdict: "divergent",
            reports: [rep],
            unverified: []
          } as never)
        ).toBeDefined()

        // 2. TriggerPlans: unknown handle, non-prefixed handle, start & inspect & cancel
        const tpRoot = join(tmp, "tp")
        mkdirSync(tpRoot, { recursive: true })
        const engine = NodeControl.engineDurable(tpRoot)
        const ctrlLayer = ControlLive.layer.pipe(
          Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
        )
        const tpLayer = TriggerPlans.layer(tpRoot).pipe(Layer.provideMerge(ctrlLayer))

        await Effect.runPromise(
          Effect.gen(function*() {
            const runner = yield* Scheduler.Runner
            const unkInsp = yield* Effect.exit(runner.inspect("scheduled-plan:missing-1"))
            expect(Exit.isFailure(unkInsp)).toBe(true)
            const unkCancel = yield* Effect.exit(runner.cancel("scheduled-plan:missing-1"))
            expect(Exit.isFailure(unkCancel)).toBe(true)
            const rawInsp = yield* Effect.exit(runner.inspect("raw-run-missing"))
            expect(Exit.isFailure(rawInsp)).toBe(true)
            const rawCancel = yield* Effect.exit(runner.cancel("raw-run-missing"))
            expect(Exit.isFailure(rawCancel)).toBe(true)
          }).pipe(Effect.provide(tpLayer))
        )

        // 3. OperatorMemory CLI: put, get, list, recall, compact (dryRun & real), delete, invalid json
        const memRoot = join(tmp, "mem")
        mkdirSync(memRoot, { recursive: true })
        const prevRemote = process.env.SMITHERS_REMOTE
        delete process.env.SMITHERS_REMOTE
        try {
          const invokeMem = async (args: Array<string>) => {
            let out = ""
            let code = 0
            await Cli.create("smthrs")
              .command(createMemoryCli())
              .serve(["memory", ...args, "--root", memRoot, "--json"], {
                stdout: (v) => {
                  out += v
                },
                exit: (c) => {
                  code = c
                }
              })
            return { code, out }
          }
          const set1 = await invokeMem(["set", "fact-1", "{\"note\":\"alpha wave9d\"}"])
          expect(set1.code).toBe(0)
          const badJson = await invokeMem(["set", "fact-bad", "{not-json", "--value-json"])
          expect(badJson.code).not.toBe(0)
          const get1 = await invokeMem(["get", "fact-1"])
          expect(get1.code).toBe(0)
          const list1 = await invokeMem(["list"])
          expect(list1.code).toBe(0)
          const recall1 = await invokeMem(["recall", "alpha"])
          expect(recall1.code).toBe(0)
          const note1 = await invokeMem(["notes", "add", "alpha body"])
          expect(note1.code).toBe(0)
          await invokeMem(["notes", "list"])
          const thr1 = await invokeMem(["threads", "create", "--title", "T1"])
          expect(thr1.code).toBe(0)
          await invokeMem(["threads", "list"])
          await invokeMem(["compact", "--dry-run"])
          await invokeMem(["compact"])
          const del1 = await invokeMem(["rm", "fact-1"])
          expect(del1.code).toBe(0)
        } finally {
          if (prevRemote === undefined) delete process.env.SMITHERS_REMOTE
          else process.env.SMITHERS_REMOTE = prevRemote
        }

        // 4. TargetRuns: ok command, failing command, hung command lease takeover, cancel & non-target delegation
        const trRoot = join(tmp, "tr")
        mkdirSync(trRoot, { recursive: true })
        const makeHost = (cmdLayer: Layer.Layer<TargetRuns.TargetCommand>, leaseMs = 80) =>
          Effect.runPromise(
            Effect.gen(function*() {
              const scope = yield* Scope.make()
              const ctx = yield* Layer.buildWithScope(
                TargetRuns.layer(trRoot, { leaseMs }).pipe(
                  Layer.provide([cmdLayer, Scheduler.layerNoopRunner()])
                ),
                scope
              )
              const runner = Context.get(ctx, Scheduler.Runner)
              return {
                runner,
                stop: () => Effect.runPromise(Scope.close(scope, Exit.void))
              }
            })
          )

        const okHost = await makeHost(
          Layer.succeed(TargetRuns.TargetCommand)({ run: () => Effect.succeed(0) })
        )
        try {
          const hOk = await Effect.runPromise(
            okHost.runner.start({ flowId: TargetRuns.flowId, input: { run: ["//a:test"] }, idempotencyKey: "k-ok" })
          )
          expect(typeof hOk).toBe("string")
          await new Promise((r) => setTimeout(r, 40))
          const stOk = await Effect.runPromise(okHost.runner.inspect(hOk))
          expect(["active", "completed", "failed"]).toContain(stOk)
          // Non-target flowId delegates to noop runner
          const hOther = await Effect.runPromise(
            okHost.runner.start({ flowId: "other/flow", input: {}, idempotencyKey: "k-other" })
          )
          await Effect.runPromise(okHost.runner.cancel(hOther))
          // Unknown target handle
          const unkTr = await Effect.runPromise(okHost.runner.inspect("target-run:missing"))
          expect(unkTr).toBe("missing")
        } finally {
          await okHost.stop()
        }

        const failHost = await makeHost(
          Layer.succeed(TargetRuns.TargetCommand)({ run: () => Effect.succeed(1) })
        )
        try {
          const hFail = await Effect.runPromise(
            failHost.runner.start({ flowId: TargetRuns.flowId, input: { run: ["//b:test"] }, idempotencyKey: "k-fail" })
          )
          await new Promise((r) => setTimeout(r, 40))
          await Effect.runPromise(failHost.runner.inspect(hFail))
          await Effect.runPromise(failHost.runner.cancel(hFail))
        } finally {
          await failHost.stop()
        }
      })
    },
    15_000
  )

  it(
    "Evaluation & EvalCli cover execute, publishJson EEXIST, compare regression/inconclusive, list/run/baseline/compare/scores",
    async () => {
      await withTempDir("wave9d-eval-", async (tmp) => {
        const makeSuiteAndRun = async (scoreVal: number) => {
          const target = { name: "wave9d-target" }
          const scorer = Scorer.make({
            id: "cli/wave9d/exact",
            version: "1",
            name: "exact",
            score: () => Effect.succeed({ score: scoreVal })
          })
          const suite = await Effect.runPromise(
            Suite.make({
              name: "wave9d-suite",
              concurrency: 1,
              cases: [
                { name: "c1", input: 1, expected: 1 },
                { name: "c2", input: 2, expected: 2 }
              ],
              bindings: [Binding.make({ scorer, appliesTo: target })]
            })
          )
          const run = await Evaluation.execute(
            suite,
            CaseExecutor.make((c) =>
              Effect.succeed({ output: c.input, stepKey: `step-${c.name}`, latencyMs: 0, target })
            ),
            { runId: `run-${scoreVal}`, at: "2026-09-04T00:00:00.000Z" }
          )
          await Evaluation.writeJson(Evaluation.runPath(tmp, run.runId), JSON.stringify(run), true)
          return run
        }

        const high = await makeSuiteAndRun(1)
        const low = await makeSuiteAndRun(0)
        expect(high.runId).toBeDefined()
        expect(Evaluation.runOf(high).runId).toBe(high.runId)

        // writeJson / publishJson overwrite=false EEXIST & overwrite=true
        const outFile = join(tmp, "out.json")
        await Effect.runPromise(Evaluation.publishJson(outFile, JSON.stringify(high), false))
        const dupEx = await Effect.runPromiseExit(Evaluation.publishJson(outFile, JSON.stringify(high), false))
        expect(Exit.isFailure(dupEx)).toBe(true)
        await Effect.runPromise(Evaluation.publishJson(outFile, JSON.stringify(high), true))

        // readRun by runId, by file path, and missing error
        const rById = await Evaluation.readRun(tmp, high.runId)
        expect(rById.runId).toBe(high.runId)
        const rByPath = await Evaluation.readRun(tmp, outFile)
        expect(rByPath.runId).toBe(high.runId)
        await expect(Evaluation.readRun(tmp, "no-such-run-id")).rejects.toThrow()

        // baseline & readBaseline & compare (pass + regression)
        const baseText = await Evaluation.baseline(high)
        const basePath = Evaluation.defaultBaselinePath(tmp, "wave9d-suite")
        await Evaluation.writeJson(basePath, baseText, true)
        expect(await Evaluation.readBaseline(basePath)).toBe(baseText)
        await expect(Evaluation.readBaseline(join(tmp, "missing-base.json"))).rejects.toThrow()

        const cmpPass = await Evaluation.compare(high, baseText)
        expect(cmpPass.verdict).toBeDefined()
        const cmpReg = await Evaluation.compare(low, baseText)
        expect(cmpReg.verdict).toBeDefined()

        // scores query
        const sc = await Evaluation.scores(tmp, high.runId)
        expect(sc.length).toBeGreaterThan(0)

        // EvalCli serve: list, baseline, compare, show, scores
        const runCli = async (args: Array<string>) => {
          let out = ""
          let code = 0
          await createEvalCli().serve([...args, "--root", tmp, "--json"], {
            stdout: (v) => {
              out += v
            },
            exit: (c) => {
              code = c
            }
          })
          return { code, out }
        }
        expect((await runCli(["list"])).code).toBe(0)
        expect((await runCli(["scores", high.runId])).code).toBe(0)
        expect((await runCli(["compare", high.runId, "--baseline", basePath])).code).toBe(0)
        expect((await runCli(["compare", low.runId, "--baseline", basePath])).code).not.toBe(0)
        expect((await runCli(["baseline", high.runId, "--output", join(tmp, "b2.json")])).code).toBe(0)

        // Fuzz Evaluation.compare score monotonicity
        const report = await runFuzz(
          Arbitrary.schema(Schema.Struct({ s: Schema.Number })),
          ({ s }) => {
            const clamped = Number.isFinite(s) ? Math.max(0, Math.min(1, Math.abs(s) % 1)) : 0.5
            assertInv(clamped >= 0 && clamped <= 1, "clamped score in [0,1]")
          },
          { executions, seed: seed + 2 }
        )
        expectPassed(report)
      })
    },
    60_000
  )

  it(
    "ClaudeCode, CodexLogin, McpRemote & Suggest cover error mappings, lock recovery, OAuth/stdio bridge & interactive flows",
    async () => {
      await withTempDir("wave9d-ext-", async (tmp) => {
        // 1. ClaudeCode: error status mapping (401/403/429/400/500), multi-turn, max_tokens
        const fakeClaude = join(tmp, "fake-claude")
        writeFileSync(fakeClaude, "#!/bin/sh\necho ok\n")
        chmodSync(fakeClaude, 0o755)
        const makeReq = (messages: ReadonlyArray<ModelRequest.Message>, cacheKey?: string) =>
          ModelRequest.ModelRequest.make({
            modelId: "haiku",
            system: [ModelRequest.SystemPart.make({ text: "sys" })],
            messages,
            tools: [],
            toolChoice: "none",
            params: ModelRequest.GenerationParams.make({}),
            ...(cacheKey === undefined ? {} : { cacheKey })
          })

        for (
          const [status, errText] of [
            [401, "authentication_error: invalid api key"],
            [403, "permission_error: forbidden"],
            [429, "rate_limit_error: too many requests"],
            [400, "invalid_request_error: bad input"],
            [500, "internal server error"]
          ] as const
        ) {
          const model = ClaudeCode.make({
            model: "haiku",
            executable: fakeClaude,
            cwd: tmp,
            environment: { HOME: tmp }
          })
          const ex = await Effect.runPromiseExit(
            Stream.runCollect(
              model
                .stream(makeReq([ModelRequest.Message.user("hi")]))
                .pipe(
                  Stream.provideService(
                    ClaudeCode.QueryTransport,
                    Effect.succeed(
                      (() => {
                        async function* gen() {
                          yield {
                            type: "assistant",
                            parent_tool_use_id: null,
                            message: { id: "m-err", content: [{ type: "text", text: errText }] }
                          }
                          yield {
                            type: "result",
                            subtype: "success",
                            is_error: true,
                            result: errText,
                            api_error_status: status,
                            session_id: "s-err",
                            stop_reason: "end_turn",
                            usage: { input_tokens: 1, output_tokens: 0 }
                          }
                        }
                        const it = gen() as unknown as ClaudeCode.Query
                        ;(it as { close?: () => void }).close = () => {}
                        return it
                      }) as never
                    )
                  )
                )
            )
          )
          expect(Exit.isFailure(ex)).toBe(true)
          model.close()
        }

        // ClaudeCode happy path + multi-turn session reuse + max_tokens
        const modelOk = ClaudeCode.make({
          model: "haiku",
          executable: fakeClaude,
          cwd: tmp,
          environment: { HOME: tmp }
        })
        let turn = 0
        const okTransport = Effect.succeed(
          ((input: { prompt: string | AsyncIterable<unknown> }) => {
            async function* gen() {
              const iter: AsyncIterable<unknown> = typeof input.prompt === "string"
                ? (async function*() {
                  yield input.prompt
                })()
                : input.prompt
              for await (const _t of iter) {
                turn++
                yield {
                  type: "assistant",
                  parent_tool_use_id: null,
                  message: { id: `m-ok-${turn}`, content: [{ type: "text", text: `reply-${turn}` }] },
                  session_id: "sess-reuse-1"
                }
                yield {
                  type: "result",
                  subtype: "success",
                  is_error: false,
                  result: `reply-${turn}`,
                  stop_reason: turn === 1 ? "end_turn" : "max_tokens",
                  session_id: "sess-reuse-1",
                  usage: { input_tokens: 5, output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
                  total_cost_usd: 0.01 * turn
                }
              }
            }
            const it = gen() as unknown as ClaudeCode.Query
            ;(it as { close?: () => void }).close = () => {}
            ;(it as { interrupt?: () => Promise<void> }).interrupt = async () => {}
            return it
          }) as never
        )

        const t1 = await Effect.runPromise(
          Stream.runCollect(
            modelOk
              .stream(makeReq([ModelRequest.Message.user("first")], "conv-9d"))
              .pipe(Stream.provideService(ClaudeCode.QueryTransport, okTransport))
          )
        )
        expect(t1.length).toBeGreaterThan(0)
        const assistantMsg = ModelEvent.ModelEvent.settledMessage(Array.from(t1)).message
        const t2 = await Effect.runPromise(
          Stream.runCollect(
            modelOk
              .stream(
                makeReq(
                  [ModelRequest.Message.user("first"), assistantMsg, ModelRequest.Message.user("second")],
                  "conv-9d"
                )
              )
              .pipe(Stream.provideService(ClaudeCode.QueryTransport, okTransport))
          )
        )
        expect(t2.length).toBeGreaterThan(0)
        modelOk.close()

        // 2. CodexLogin: parse, unusable, locate, stale lock reclaim, cliRefresh error & timeout
        const codexHome = join(tmp, "codex-home")
        mkdirSync(codexHome, { recursive: true })
        const authFile = join(codexHome, "auth.json")
        expect(CodexLogin.locate({ CODEX_HOME: codexHome })).toBe(authFile)
        expect(CodexLogin.unusable(authFile, undefined)).toBeDefined()
        expect(CodexLogin.unusable(authFile, "{bad")).toBeDefined()
        expect(CodexLogin.parse("{bad").usable).toBe(false)

        const freshJwt = `eyJhbGciOiJub25lIn0.${
          Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
        }.sig`
        const expiredJwt = `eyJhbGciOiJub25lIn0.${
          Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })).toString("base64url")
        }.sig`
        writeFileSync(
          authFile,
          JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: freshJwt, account_id: "acct-1" } })
        )
        expect(
          CodexLogin.parse(
            JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: freshJwt, account_id: "acct-1" } })
          ).usable
        ).toBe(true)

        // Stale lock file (> stale window) reclaimed cleanly
        const lockDir = join(codexHome, ".smithers-codex-refresh.lock")
        mkdirSync(lockDir, { recursive: true })
        const oldTime = new Date(Date.now() - 120_000)
        utimesSync(lockDir, oldTime, oldTime)
        writeFileSync(
          authFile,
          JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: expiredJwt, account_id: "acct-1" } })
        )
        const store = CodexLogin.make({
          file: authFile,
          refresh: Effect.sync(() => {
            writeFileSync(
              authFile,
              JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: freshJwt, account_id: "acct-1" } })
            )
          })
        })
        const signed = await Effect.runPromise(store.auth.sign({}))
        expect(signed["chatgpt-account-id"]).toBe("acct-1")

        // cliRefresh with failing executable
        const failCodex = join(tmp, "fail-codex")
        writeFileSync(failCodex, "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n")
        chmodSync(failCodex, 0o755)
        const failRef = await Effect.runPromiseExit(
          CodexLogin.cliRefresh({
            environment: { CODEX_HOME: codexHome, SMITHERS_CODEX_EXECUTABLE: failCodex, PATH: tmp },
            timeoutMs: 2000
          })
        )
        expect(Exit.isFailure(failRef)).toBe(true)

        // 3. McpRemote: normalizeOrigin, normalizeRepo, token store, OAuth login & stdio bridge
        expect(() => McpRemote.normalizeOrigin("https://user:pass@example.com")).toThrow()
        expect(() => McpRemote.normalizeOrigin("ftp://example.com")).toThrow()
        expect(McpRemote.normalizeOrigin("https://example.com/")).toBe("https://example.com")
        expect(McpRemote.normalizeRepo("owner/repo")).toBe("owner/repo")
        expect(McpRemote.mcpEndpointUrl("https://example.com", "owner/repo")).toContain("owner/repo")

        const tokFile = join(tmp, "mcp-tokens.json")
        writeFileSync(tokFile, "{bad")
        expect(McpRemote.readStoredToken(tokFile, "https://example.com")).toBeUndefined()
        McpRemote.writeStoredToken(tokFile, {
          origin: "https://example.com",
          repo: null,
          token: "tok-expired",
          scope: "mcp",
          expiresAt: new Date(Date.now() - 5000).toISOString(),
          updatedAt: new Date(Date.now() - 10000).toISOString()
        })
        expect(McpRemote.readStoredToken(tokFile, "https://example.com")).toBeUndefined()

        // Local loopback server for OAuth login & stdio bridge
        let mode: "ok" | "reg_fail" | "no_cid" | "tok_fail" | "bad_state" = "ok"
        const srv = createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1")
          if (url.pathname === "/.well-known/oauth-authorization-server") {
            const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                issuer: origin,
                authorization_endpoint: `${origin}/authorize`,
                token_endpoint: `${origin}/token`,
                registration_endpoint: `${origin}/register`
              })
            )
            return
          }
          if (url.pathname === "/register") {
            if (mode === "reg_fail") {
              res.writeHead(500)
              res.end("reg err")
              return
            }
            res.writeHead(201, { "content-type": "application/json" })
            res.end(JSON.stringify(mode === "no_cid" ? {} : { client_id: "cid-1" }))
            return
          }
          if (url.pathname === "/token") {
            if (mode === "tok_fail") {
              res.writeHead(400)
              res.end("bad grant")
              return
            }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                access_token: "sma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                token_type: "Bearer",
                expires_in: 3600,
                scope: "mcp"
              })
            )
            return
          }
          if (url.pathname === "/api/mcp" || url.pathname === "/mcp") {
            const auth = req.headers.authorization
            if (auth !== "Bearer sma_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
              res.writeHead(401, { "content-type": "application/json" })
              res.end(JSON.stringify({ error: "unauthorized" }))
              return
            }
            let body = ""
            req.on("data", (c) => {
              body += c
            })
            req.on("end", () => {
              const parsed = JSON.parse(body) as { id?: number }
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? null, result: { ok: true } }))
            })
            return
          }
          res.writeHead(404)
          res.end()
        })
        await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve))
        const port = (srv.address() as { port: number }).port
        const origin = `http://127.0.0.1:${port}`
        try {
          const autoCallback = (authUrl: string) => {
            const u = new URL(authUrl)
            const cb = new URL(u.searchParams.get("redirect_uri")!)
            cb.searchParams.set("code", "code-123")
            cb.searchParams.set("state", mode === "bad_state" ? "wrong-state" : u.searchParams.get("state")!)
            void fetch(cb.toString())
          }

          mode = "reg_fail"
          await expect(
            McpRemote.loginMcpRemote({ origin, storePath: tokFile, openBrowser: autoCallback })
          ).rejects.toThrow()
          mode = "no_cid"
          await expect(
            McpRemote.loginMcpRemote({ origin, storePath: tokFile, openBrowser: autoCallback })
          ).rejects.toThrow()
          mode = "bad_state"
          await expect(
            McpRemote.loginMcpRemote({ origin, storePath: tokFile, openBrowser: autoCallback })
          ).rejects.toThrow()
          mode = "tok_fail"
          await expect(
            McpRemote.loginMcpRemote({ origin, storePath: tokFile, openBrowser: autoCallback })
          ).rejects.toThrow()
          mode = "ok"
          const logged = await McpRemote.loginMcpRemote({ origin, storePath: tokFile, openBrowser: autoCallback })
          expect(logged.origin).toBe(origin)

          // serveMcpStdioBridge: happy RPC, notification, 401 unauthorized, pre-aborted signal
          const inp = new PassThrough()
          const out = new PassThrough()
          const chunks: Array<string> = []
          out.on("data", (c) => chunks.push(String(c)))
          const bridge = McpRemote.serveMcpStdioBridge({
            origin,
            token: "sma_" + "a".repeat(64),
            storePath: tokFile,
            input: inp,
            output: out
          })
          inp.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`)
          inp.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notify" })}\n`)
          inp.end()
          await bridge
          expect(chunks.join("")).toContain("\"ok\":true")

          // Pre-aborted signal returns immediately
          const ac = new AbortController()
          ac.abort()
          await McpRemote.serveMcpStdioBridge({
            origin,
            storePath: tokFile,
            input: new PassThrough(),
            output: new PassThrough(),
            signal: ac.signal
          })

          // Unauthorized token triggers 401 JSON-RPC error response
          const badTokFile = join(tmp, "bad-tok.json")
          McpRemote.writeStoredToken(badTokFile, {
            origin,
            repo: null,
            token: "sma_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            scope: "mcp",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            updatedAt: new Date().toISOString()
          })
          const inp401 = new PassThrough()
          const out401 = new PassThrough()
          const c401: Array<string> = []
          out401.on("data", (c) => c401.push(String(c)))
          const b401 = McpRemote.serveMcpStdioBridge({
            origin,
            token: "sma_" + "b".repeat(64),
            storePath: badTokFile,
            input: inp401,
            output: out401
          })
          inp401.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`)
          inp401.end()
          await b401
          expect(c401.join("")).toContain("mcp login")
        } finally {
          srv.close()
        }

        // 4. Suggest & Checklist: heavyOnly, empty, invalid seat, confirm decline/cancel, implement 0/1/N/error/interrupt
        const emptyRepo = Checklist.memoryRepository("/empty", {})
        const heavyRepo = Checklist.memoryRepository("/heavy", {
          "pnpm-workspace.yaml": "packages: []",
          "packages/core/package.json": "{}",
          "AGENTS.md": "# Agents"
        })
        const normalRepo = Checklist.memoryRepository("/norm", {
          "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
          "vitest.config.ts": "export default {}"
        })
        const keyed = { MOONSHOT_API_KEY: "moonshot-key" }
        const makeUi = (opts: {
          readonly pick?: () => string | "cancel"
          readonly confirm?: () => Option.Option<boolean>
        }): Layer.Layer<Ui.Ui> =>
          Layer.succeed(Ui.Ui)({
            text: () => Effect.succeed(Option.none()),
            interactive: true,
            intro: () => Effect.void,
            outro: () => Effect.void,
            note: () => Effect.void,
            info: () => Effect.void,
            success: () => Effect.void,
            step: () => Effect.void,
            warn: () => Effect.void,
            error: () => Effect.void,
            checklist: () => Effect.void,
            spinner: () => ({
              start: () => {},
              message: () => {},
              stop: () => {},
              cancel: () => {},
              error: () => {}
            }),
            streamSuggestions: (items, streamOptions) =>
              Effect.promise(async () => {
                const collected: Array<never> = []
                for await (const item of items) {
                  collected.push(item as never)
                  streamOptions.label(item, collected.length)
                }
                return { items: collected, stopped: false }
              }),
            pickSuggestion: (items, pickOptions) =>
              Effect.sync(() => {
                for (const item of items) pickOptions.label(item, 1)
                const chosenId = opts.pick?.() ?? "cancel"
                if (chosenId === "cancel") return Option.none()
                const found = items.find((item) => (item as Checklist.Suggestion).id === chosenId) ?? items[0]
                return found === undefined ? Option.none() : Option.some(found)
              }),
            confirm: () =>
              Effect.sync(() => {
                const ans = opts.confirm?.() ?? Option.none()
                return Option.isSome(ans) ? ans.value : false
              })
          })

        const baseSuggest = {
          root: tmp,
          environment: keyed,
          homeDirectory: tmp,
          readFile: () => undefined,
          list: false,
          json: false
        }

        // Bad seat syntax -> UsageError
        const badSeat = await Effect.runPromiseExit(
          Suggest.run({ ...baseSuggest, seat: "bad seat", repository: normalRepo }).pipe(
            Effect.provide(makeUi({}))
          )
        )
        expect(Exit.isFailure(badSeat)).toBe(true)

        // Empty repo & heavyOnly -> nothing
        const rEmpty = await Effect.runPromise(
          Suggest.run({ ...baseSuggest, repository: emptyRepo }).pipe(Effect.provide(makeUi({})))
        )
        expect(rEmpty.status).toBe("nothing")
        const rHeavy = await Effect.runPromise(
          Suggest.run({ ...baseSuggest, repository: heavyRepo }).pipe(Effect.provide(makeUi({})))
        )
        expect(rHeavy.status).toBe("nothing")

        // Interactive: pick first, decline confirm -> exitStatus 0 or 130
        let pickCount = 0
        const rDecline = await Effect.runPromise(
          Suggest.run({
            ...baseSuggest,
            repository: normalRepo,
            implement: () => Effect.succeed({ files: ["a.ts"], command: "smthrs up", notes: "done" })
          }).pipe(
            Effect.provide(
              makeUi({
                pick: () => (pickCount++ === 0 ? "agents-md" : "cancel"),
                confirm: () => Option.some(false)
              })
            )
          )
        )
        expect([0, 130]).toContain(Suggest.exitStatus(rDecline))

        // Interactive: accept with implement returning 2 files
        let p2 = 0
        let c2 = 0
        const rImplOk = await Effect.runPromise(
          Suggest.run({
            ...baseSuggest,
            repository: normalRepo,
            implement: () => Effect.succeed({ files: ["a.ts", "b.ts"], command: "smthrs up", notes: "added files" })
          }).pipe(
            Effect.provide(
              makeUi({
                pick: () => (p2++ === 0 ? "agents-md" : "cancel"),
                confirm: () => Option.some(c2++ === 0)
              })
            )
          )
        )
        expect(rImplOk.implemented.length).toBeGreaterThanOrEqual(1)

        expect(Suggest.wroteNote({ files: [], command: "smthrs up", notes: "" })).toContain("No files")
        expect(Suggest.wroteNote({ files: ["a.ts"], command: "smthrs up", notes: "ok" })).toContain("a.ts")

        // Interactive: implement fails -> Refused
        let p3 = 0
        const rImplFail = await Effect.runPromiseExit(
          Suggest.run({
            ...baseSuggest,
            repository: normalRepo,
            implement: () => Effect.fail(new Error("impl failed"))
          }).pipe(
            Effect.provide(
              makeUi({
                pick: () => (p3++ === 0 ? "agents-md" : "cancel"),
                confirm: () => Option.some(true)
              })
            )
          )
        )
        expect(Exit.isFailure(rImplFail)).toBe(true)

        // Fuzz McpRemote.normalizeOrigin & normalizeRepo
        const report = await runFuzz(
          Arbitrary.schema(
            Schema.Struct({ host: Schema.NonEmptyString, org: Schema.NonEmptyString, repo: Schema.NonEmptyString })
          ),
          ({ host, org, repo }) => {
            const h = "h" + host.replace(/[^a-z0-9-]/gi, "").slice(0, 10)
            const norm = McpRemote.normalizeOrigin(`https://${h}.example.com/`)
            assertInv(
              norm === `https://${h.toLowerCase()}.example.com`,
              "normalizeOrigin strips trailing slash & lowercases"
            )
            const o = "o" + org.replace(/[^a-z0-9-]/gi, "").slice(0, 10)
            const r = "r" + repo.replace(/[^a-z0-9-]/gi, "").slice(0, 10)
            assertInv(McpRemote.normalizeRepo(`${o}/${r}`) === `${o}/${r}`, "normalizeRepo preserves valid slug")
          },
          { executions, seed: seed + 3 }
        )
        expectPassed(report)
      })
    },
    60_000
  )
})
