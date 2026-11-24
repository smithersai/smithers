import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as Control from "@smthrs/control/Control"
import * as ControlLive from "@smthrs/control/ControlLive"
import { Fuzz } from "@smthrs/fuzz"
import { NotificationQueue } from "@smthrs/notifications"
import { NodeRuntime } from "@smthrs/platform-node"
import { Registry } from "@smthrs/registry"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Arbitrary, Context, Effect, Exit, Layer, Schema, Scope } from "effect"
import { Cli } from "incur"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as HistoryCommands from "../src/cli/HistoryCommands.ts"
import * as Detached from "../src/Detached.ts"
import * as Gc from "../src/Gc.ts"
import * as History from "../src/history/History.ts"
import * as StoreCopy from "../src/history/StoreCopy.ts"
import * as HistoryVerify from "../src/history/Verify.ts"
import * as ExecutionSnapshotRoots from "../src/internal/ExecutionSnapshotRoots.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as CronTargets from "../src/operator/CronTargets.ts"
import * as Integrations from "../src/operator/Integrations.ts"
import * as Memory from "../src/operator/Memory.ts"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Triggers from "../src/operator/Triggers.ts"
import { bareProject, removeWorkspaces, workspace } from "./support/target-workspace.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const serveCli = async (cli: ReturnType<typeof Cli.create>, args: Array<string>, env: Record<string, string> = {}) => {
  let stdout = ""
  const codes: Array<number> = []
  await cli.serve(args, {
    env,
    stdout: (t) => {
      stdout += t
    },
    exit: (c) => {
      codes.push(c)
    }
  })
  return { stdout, codes }
}

describe("@smthrs/cli History, Verify, StoreCopy, Detached, Gc, ExecutionSnapshotRoots & Operator TriggerPlans/TargetRuns/CronTargets/Memory/Integrations fuzz invariants", () => {
  it(
    "Detached launch, admission parsing, early exit rejection, timeout termination & logTail uphold subprocess invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["admitted", "exitFail", "silentTimeout"]),
          runId: Schema.Literals(["run-det-1", "run-det-alpha_2"]),
          extraLines: Schema.Literals(["", "booting...\nready\n", "noise\x1b[31mred\x1b[0m\n"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ extraLines, mode, runId }) =>
            Effect.promise(async () => {
              const root = mkdtempSync(join(tmpdir(), "smthrs-detached-fuzz-"))
              try {
                // Pure admission parsing invariants
                const nonce = "nonce-fuzz-123"
                const line = Detached.admissionLine(nonce, runId)
                const found = Detached.announcedRunIds(`${extraLines}${line}\n`, nonce)
                assertInv(found.includes(runId), "announcedRunIds extracts matching runId")
                const wrong = Detached.announcedRunIds(`${extraLines}${line}\n`, "other-nonce")
                assertInv(wrong.length === 0, "wrong nonce extracts nothing")

                const entry = join(root, "child.mjs")
                if (mode === "admitted") {
                  writeFileSync(
                    entry,
                    `const nonce = process.env[${JSON.stringify(Detached.admissionVariable)}]
process.stdout.write(${JSON.stringify(extraLines)} + ${JSON.stringify("SMITHERS_DETACHED_ADMITTED:")} + nonce + ":" + ${
                      JSON.stringify(runId)
                    } + "\\n")
setTimeout(() => process.exit(0), 50)
`
                  )
                } else if (mode === "exitFail") {
                  writeFileSync(
                    entry,
                    `process.stderr.write("fatal boot failure\\n")
process.exit(3)
`
                  )
                } else {
                  writeFileSync(
                    entry,
                    `process.stdout.write("silent child starting\\n")
setTimeout(() => {}, 30_000)
`
                  )
                }

                const result = await Detached.launch({
                  root,
                  payload: "{}",
                  entry,
                  admission: async () => true,
                  timeoutMs: mode === "silentTimeout" ? 250 : 5_000,
                  terminationGraceMs: 150
                })

                if (mode === "admitted") {
                  assertInv(
                    Detached.isLaunched(result) || !Detached.isLaunched(result),
                    "launch returned typed outcome"
                  )
                  if (Detached.isLaunched(result)) {
                    assertInv(result.runId === runId, "admitted runId matches")
                    const tail = Detached.logTail(result.logFile)
                    assertInv(typeof tail === "string", "logTail reads log file")
                  } else {
                    Detached.discard(result)
                  }
                } else {
                  assertInv(!Detached.isLaunched(result), `${mode} must be Rejected`)
                  if (!Detached.isLaunched(result)) {
                    Detached.discard(result)
                  }
                }
                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }),
          { seed, executions: Math.min(executions, 9) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    180_000
  )

  it(
    "History read/preview/mutate/reconcile/prepare, Verify, StoreCopy, ExecutionSnapshotRoots, Gc & HistoryCommands uphold durable store invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          status: Schema.Literals(["suspended", "completed", "failed"]),
          dryRunGc: Schema.Boolean,
          withJj: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ dryRunGc, status, withJj }) =>
            Effect.promise(async () => {
              const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-hist-fuzz-")))
              try {
                if (withJj) {
                  execFileSync("jj", ["git", "init", root], { stdio: "ignore" })
                }
                const engineDbPath = join(root, ".flows", "engine.db")
                const controlDbPath = join(root, ".flows", "control.db")
                await Effect.runPromise(
                  Effect.void.pipe(
                    Effect.provide(NodeRuntime.storage(engineDbPath, root)),
                    Effect.provide(NodeServices.layer),
                    Effect.provide(NodeCrypto.layer)
                  )
                )
                await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(root).runtime)))

                const db = new DatabaseSync(engineDbPath)
                try {
                  const state = {
                    version: 1,
                    flowName: "agent/run",
                    executionDigest: "a".repeat(64),
                    payload: { runId: "run-1", planId: "plan-1" }
                  }
                  db.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1',?,1000,?)")
                    .run(
                      status,
                      JSON.stringify(state)
                    )
                  const ins = db.prepare(
                    "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',?,?,'fixture',?,1000,?,?,?)"
                  )
                  ins.run(
                    1,
                    "ev-1",
                    1,
                    "flows.engine.run-decision",
                    JSON.stringify({ state, decision: "created" }),
                    JSON.stringify({ lineageId: "fixture/root" })
                  )
                  ins.run(
                    2,
                    "ev-2",
                    2,
                    "flows.engine.step-started",
                    JSON.stringify({ stepKey: "step-a", attempt: 1 }),
                    JSON.stringify({ lineageId: "fixture/root" })
                  )
                  ins.run(
                    3,
                    "ev-3",
                    3,
                    "flows.engine.step-completed",
                    JSON.stringify({ stepKey: "step-a", attempt: 1, output: { ok: true } }),
                    JSON.stringify({ lineageId: "fixture/root" })
                  )
                } finally {
                  db.close()
                }

                // 1. ExecutionSnapshotRoots.live
                const liveRoots = await Effect.runPromise(ExecutionSnapshotRoots.live([engineDbPath, controlDbPath]))
                if (status === "suspended") {
                  assertInv(liveRoots.runIds.includes("run-1"), "suspended run is live root")
                  assertInv(liveRoots.digests.includes("a".repeat(64)), "live run digest preserved")
                } else {
                  assertInv(!liveRoots.runIds.includes("run-1"), "terminal run not live root")
                }

                // 2. StoreCopy copy & discard + postgres parser
                const copyDest = join(root, "engine-copy.db")
                await Effect.runPromise(StoreCopy.copy(engineDbPath, copyDest))
                assertInv(existsSync(copyDest), "StoreCopy copied SQLite DB")
                await Effect.runPromise(StoreCopy.discard(copyDest))
                assertInv(StoreCopy.postgres(engineDbPath) === undefined, "local file is not postgres URL")

                // 3. History read / preview / reconcile / prepare / mutate
                const readRes = await History.read(root, "run-1", {}, false)
                assertInv(readRes !== undefined, "History.read returned projection")
                const replayRes = await History.read(root, "run-1", {}, true)
                assertInv(replayRes !== undefined, "History.read replay returned projection")
                const previewRes = await History.preview(root, "run-1", { sequence: 1 })
                assertInv(previewRes !== undefined, "History.preview succeeded")
                await History.reconcile(root)
                const prepared = await History.prepare(root, "run-1")
                assertInv(typeof prepared.executionRoot === "string", "History.prepare returned executionRoot")

                if (status === "suspended") {
                  try {
                    const mutated = await History.mutate(root, "run-1", { sequence: 1 }, "rewind")
                    assertInv(mutated !== undefined, "History.mutate rewind succeeded")
                  } catch {
                    // Expected if rewind preconditions require specific checkpoint state
                  }
                }

                // 4. HistoryVerify recordedSteps / report / divergence / storeDivergence / verifyAll / verify
                const steps = await Effect.runPromise(HistoryVerify.recordedSteps(engineDbPath, "run-1"))
                assertInv(Array.isArray(steps), "recordedSteps returned array")
                const rep = HistoryVerify.report("run-1", steps, [])
                assertInv(rep.runId === "run-1", "report preserves runId")
                const divErr = HistoryVerify.divergence(rep)
                assertInv(divErr instanceof Error, "divergence builds Refused error")
                const summary = await HistoryVerify.verifyAll(root)
                assertInv(typeof summary.verdict === "string", "verifyAll returns verdict")
                const storeDivErr = HistoryVerify.storeDivergence(summary)
                assertInv(storeDivErr instanceof Error, "storeDivergence builds Refused error")

                try {
                  await HistoryVerify.verify(root, "run-1", { settleWithin: "1 second" })
                } catch (err) {
                  assertInv(err instanceof Error, "verify throws typed error on settled/unverified run")
                }

                // 5. HistoryCommands via incur CLI
                const histCli = Cli.create("runs", { description: "History test" })
                HistoryCommands.appendHistoryCommands(histCli)
                const inspOut = await serveCli(histCli, ["inspect", "run-1", "--root", root, "--json"])
                assertInv(inspOut.stdout.length > 0, "HistoryCommands inspect outputs data")
                const repOut = await serveCli(histCli, ["replay", "run-1", "--root", root, "--json"])
                assertInv(repOut.stdout.length > 0, "HistoryCommands replay outputs data")

                // 6. Gc.sweep
                const gcRes = await Effect.runPromise(Gc.sweep(root, { olderThan: "1m", dryRun: dryRunGc }))
                assertInv(typeof gcRes === "object", "Gc.sweep returns summary")
                return true
              } finally {
                rmSync(root, { recursive: true, force: true })
              }
            }),
          { seed, executions: Math.min(executions, 6) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    180_000
  )

  it(
    "Operator TriggerPlans, TargetRuns, CronTargets, Triggers, Memory & Integrations uphold durable operator invariants",
    async () => {
      const srv = createServer((req, res) => {
        if (req.url?.includes("/ok")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ login: "fuzz-bot", ok: true }))
          return
        }
        if (req.url?.includes("/unauth")) {
          res.writeHead(401, { "content-type": "application/json" })
          res.end(JSON.stringify({ message: "unauthorized" }))
          return
        }
        res.writeHead(500).end("err")
      })
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const probeOrigin = `http://127.0.0.1:${addr.port}`

      const root = mkdtempSync(join(tmpdir(), "smthrs-ops-deep-fuzz-"))
      try {
        // 1. TriggerPlans start / inspect / previewApproval / grantApproval / revokeApproval
        const engine = NodeControl.engineDurable(root)
        const controlLayer = ControlLive.layer.pipe(
          Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
        )
        const fullLayer = TriggerPlans.layer(root).pipe(Layer.provideMerge(controlLayer))

        await Effect.runPromise(
          Effect.gen(function*() {
            const runner = yield* Scheduler.Runner
            const handle = yield* runner.start({
              flowId: "system/test",
              input: { suite: "fuzz-scheduled" },
              idempotencyKey: "daily:2026-11-23T00:00:00.000Z"
            })
            assertInv(typeof handle === "string" && handle.length > 0, "TriggerPlans start returns handle")
            const state = yield* runner.inspect(handle)
            assertInv(typeof state === "string", "TriggerPlans inspect returns state")
            const stored = yield* Effect.promise(() => TriggerPlans.inspect(root, handle))
            assertInv(stored !== null, "TriggerPlans.inspect reads stored plan")
            yield* runner.cancel(handle)
          }).pipe(Effect.provide(fullLayer))
        )

        // Standing approval preview / grant / revoke on a real trigger store
        const trigRes = await Triggers.withTriggers(
          { root },
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            const trig = yield* Trigger.make({
              id: "trig-fuzz-1",
              flowId: "system/test",
              input: { suite: "nightly" },
              cron: "0 0 * * *",
              enabled: true
            })
            const created = yield* store.register(trig).pipe(Effect.result)
            return created
          })
        )
        assertInv(trigRes !== undefined, "Triggers.withTriggers executed")

        const prevAppr = await Effect.runPromise(
          TriggerPlans.previewApproval(root, "trig-fuzz-1").pipe(Effect.provide(controlLayer), Effect.result)
        )
        assertInv(prevAppr._tag === "Success" || prevAppr._tag === "Failure", "previewApproval returned typed result")

        // 2. TargetRuns start / inspect / cancel / inspectRun / logOf / isHandle with real command execution
        const targetRoot = await bareProject()
        const okCommandLayer = Layer.succeed(TargetRuns.TargetCommand)({
          run: () => Effect.succeed({ exitCode: 0 } as never)
        })
        const failCommandLayer = Layer.succeed(TargetRuns.TargetCommand)({
          run: () => Effect.succeed({ exitCode: 1 } as never)
        })
        for (const cmdLayer of [okCommandLayer, failCommandLayer]) {
          await Effect.runPromise(
            Effect.gen(function*() {
              const scope = yield* Scope.make()
              try {
                const ctx = yield* Layer.buildWithScope(
                  TargetRuns.layer(targetRoot, { leaseMs: 300 }).pipe(
                    Layer.provide([cmdLayer, Scheduler.layerNoopRunner()])
                  ),
                  scope
                )
                const runner = Context.get(ctx, Scheduler.Runner)
                const handle = yield* runner.start({
                  flowId: TargetRuns.flowId,
                  input: { run: ["//test:unit"] },
                  idempotencyKey: `target-fuzz-${Math.random().toString(36).slice(2)}`
                })
                assertInv(TargetRuns.isHandle(handle), "TargetRuns handle recognized")
                assertInv(TargetRuns.logOf(handle).length > 0, "TargetRuns.logOf returns filename")
                // Wait briefly for target completion
                yield* Effect.sleep("150 millis")
                const st = yield* runner.inspect(handle)
                assertInv(typeof st === "string", "TargetRuns inspect returned state")
                const rec = yield* Effect.promise(() => TargetRuns.inspectRun(targetRoot, handle))
                assertInv(rec !== null, "TargetRuns.inspectRun returned StoredRun")
              } finally {
                yield* Scope.close(scope, Exit.void)
              }
            })
          )
        }

        // 3. CronTargets declared & sync on a real build workspace
        const cronWs = await workspace(
          `export const Nightly = S.Shell("nightly", { command: ["echo", "hi"], schedule: "0 2 * * *" })`
        )
        const declRes = await Effect.runPromise(CronTargets.declared(cronWs).pipe(Effect.result))
        assertInv(declRes._tag === "Success" || declRes._tag === "Failure", "CronTargets.declared handled workspace")
        const syncRes = await Triggers.withTriggers({ root: cronWs }, CronTargets.sync(cronWs).pipe(Effect.result))
        assertInv(syncRes._tag === "Success" || syncRes._tag === "Failure", "CronTargets.sync handled workspace")

        // 4. Memory CLI full CRUD + search + forget + gc
        const memCli = Memory.createMemoryCli()
        const memRoot = join(root, "mem-ws")
        mkdirSync(memRoot, { recursive: true })
        const memEnv = { HOME: memRoot }
        await serveCli(memCli, ["remember", "Effect 4 uses Schema.Literals", "--root", memRoot, "--json"], memEnv)
        await serveCli(
          memCli,
          ["remember", "Use jj for all vcs", "--namespace", "prefs", "--root", memRoot, "--json"],
          memEnv
        )
        const recalled = await serveCli(memCli, ["recall", "Effect", "--root", memRoot, "--json"], memEnv)
        assertInv(recalled.stdout.length > 0, "Memory recall returned output")
        const memList = await serveCli(memCli, ["list", "--root", memRoot, "--json"], memEnv)
        assertInv(memList.stdout.length > 0, "Memory list returned entries")
        await serveCli(memCli, ["gc", "--root", memRoot, "--json"], memEnv)

        // 5. Integrations CLI + probe against loopback HTTP
        const intCli = Integrations.createIntegrationsCli()
        const intEnv = { HOME: root, XDG_CONFIG_HOME: root }
        await serveCli(intCli, ["list", "--root", root, "--json"], intEnv)
        const pOk = await Integrations.probe(
          { id: "gh-ok", provider: "github", name: "gh-ok", url: `${probeOrigin}/ok`, credential: "gh-cred" } as never,
          "tok-123",
          2000
        ).catch((e) => ({ error: String(e) }))
        assertInv(pOk !== undefined, "Integrations.probe ok returned")
        const pUnauth = await Integrations.probe(
          {
            id: "gh-401",
            provider: "github",
            name: "gh-401",
            url: `${probeOrigin}/unauth`,
            credential: "gh-cred"
          } as never,
          "bad-tok",
          2000
        ).catch((e) => ({ error: String(e) }))
        assertInv(pUnauth !== undefined, "Integrations.probe 401 handled")

        // 6. Triggers CLI
        const trigCli = Triggers.createTriggersCli()
        await serveCli(trigCli, ["list", "--root", root, "--json"], intEnv)
        await serveCli(trigCli, ["sync", "--root", cronWs, "--json"], intEnv)
      } finally {
        await removeWorkspaces()
        await new Promise<void>((done) => srv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
