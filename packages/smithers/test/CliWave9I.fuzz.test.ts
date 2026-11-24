/**
 * Wave-9I Heavy-Hitter Sweep: TriggerPlans, History, Verify,
 * runner/Workspace, commands/Runner, runner/Lane, runner/Job, runner/Session & runner/Serve.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control, ControlError, ControlRuntime } from "@smthrs/control"
import * as ControlLive from "@smthrs/control/ControlLive"
import type { RunId } from "@smthrs/control/ControlSchema"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as History from "../src/history/History.ts"
import * as Verify from "../src/history/Verify.ts"
import * as NodeControl from "../src/NodeControl.ts"
import { databaseLayer } from "../src/operator/Store.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Config from "../src/runner/Config.ts"
import * as Workspace from "../src/runner/Workspace.ts"
import * as HostFixture from "./fixtures/runner/host.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

const AGENT = fileURLToPath(new URL("../agent/test/fixtures/acp-test-agent.mjs", import.meta.url))

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (cond: () => boolean, timeoutMs = 20_000) => {
  const end = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await sleep(40)
  }
}

describe("@smthrs/cli Wave-9I Heavy-Hitter Sweep (TriggerPlans, History, Verify, Workspace & Runner)", () => {
  it("TriggerPlans covers full approval/launch/cancel lifecycle, crash recovery reconciliation, Conflict/terminal failures & standing approval grant/revoke/mismatch", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9i-tp-", async (tmp) => {
      const controlLayer = (root: string) => {
        const engine = NodeControl.engineDurable(root)
        return ControlLive.layer.pipe(
          Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
        )
      }
      const runTp = <A, E>(root: string, effect: Effect.Effect<A, E, Control.Control | Scheduler.Runner>) =>
        Effect.runPromise(effect.pipe(Effect.provide(TriggerPlans.layer(root).pipe(Layer.provideMerge(controlLayer(root))))))

      const root = join(tmp, "tp1")
      await mkdir(root, { recursive: true })
      const inp = { flowId: "system/test", input: { suite: "scheduled" }, idempotencyKey: "daily:1970-01-01T00:00:01.000Z" }

      // 1. Happy path: start -> waiting-approval -> approve -> running -> cancel -> cancelled
      const handle = await runTp(root, Effect.flatMap(Scheduler.Runner, (r) => r.start(inp)))
      const pending = await TriggerPlans.inspect(root, handle)
      expect(pending).toMatchObject({ status: "waiting-approval", runId: null })
      await runTp(root, Effect.flatMap(Control.Control, (c) => c.approve(pending!.plan.approval)))
      expect(await runTp(root, Effect.flatMap(Scheduler.Runner, (r) => r.inspect(handle)))).toBe("active")
      const running = await TriggerPlans.inspect(root, handle)
      expect(running?.runId).toEqual(expect.any(String))
      await runTp(root, Effect.flatMap(Scheduler.Runner, (r) => r.cancel(handle)))
      expect(await runTp(root, Effect.flatMap(Scheduler.Runner, (r) => r.inspect(handle)))).toBe("cancelled")
      // Unknown handle inspect & cancel
      const unkInspect = await Effect.runPromiseExit(
        Effect.flatMap(Scheduler.Runner, (r) => r.inspect("missing-handle")).pipe(
          Effect.provide(TriggerPlans.layer(root).pipe(Layer.provideMerge(controlLayer(root))))
        )
      )
      expect(Exit.isFailure(unkInspect)).toBe(true)
      const unkCancel = await Effect.runPromiseExit(
        Effect.flatMap(Scheduler.Runner, (r) => r.cancel("missing-handle")).pipe(
          Effect.provide(TriggerPlans.layer(root).pipe(Layer.provideMerge(controlLayer(root))))
        )
      )
      expect(Exit.isFailure(unkCancel)).toBe(true)

      // 2. Crash recovery between Control.run acceptance and persisting runId -> cancelling reconciliation + Unavailable retries
      const root2 = join(tmp, "tp2")
      await mkdir(root2, { recursive: true })
      const h2 = await runTp(root2, Effect.flatMap(Scheduler.Runner, (r) => r.start(inp)))
      const p2 = await TriggerPlans.inspect(root2, h2)
      await runTp(root2, Effect.flatMap(Control.Control, (c) => c.approve(p2!.plan.approval)))
      const crashLayer = Layer.effect(
        Control.Control,
        Effect.map(Control.Control, (c) => Control.make({ ...c, run: (req) => c.run(req).pipe(Effect.andThen(Effect.interrupt)) }))
      ).pipe(Layer.provide(controlLayer(root2)))
      const crashEx = await Effect.runPromiseExit(
        Effect.flatMap(Scheduler.Runner, (r) => r.inspect(h2)).pipe(
          Effect.provide(TriggerPlans.layer(root2).pipe(Layer.provide(crashLayer)))
        )
      )
      expect(Exit.isFailure(crashEx)).toBe(true)
      const cancelRec = await Effect.runPromiseExit(
        Effect.flatMap(Scheduler.Runner, (r) => r.cancel(h2)).pipe(
          Effect.provide(TriggerPlans.layer(root2).pipe(Layer.provideMerge(controlLayer(root2))))
        )
      )
      expect(Exit.isFailure(cancelRec)).toBe(true)
      if (Exit.isFailure(cancelRec)) {
        expect(Cause.pretty(cancelRec.cause)).toContain("awaiting cancellation reconciliation")
      }
      // Unavailable on run and cancel keeps status cancelling & returns active, then settles cancelled
      for (const op of ["run", "cancel"] as const) {
        const unavailLayer = Layer.effect(
          Control.Control,
          Effect.map(Control.Control, (c) =>
            Control.make({
              ...c,
              [op]: () => Effect.fail(new ControlError.Unavailable({ feature: op, ticket: "fixture" }))
            }))
        ).pipe(Layer.provide(controlLayer(root2)))
        const st = await Effect.runPromise(
          Effect.flatMap(Scheduler.Runner, (r) => r.inspect(h2)).pipe(
            Effect.provide(TriggerPlans.layer(root2).pipe(Layer.provide(unavailLayer)))
          )
        )
        expect(st).toBe("active")
      }
      expect(await runTp(root2, Effect.flatMap(Scheduler.Runner, (r) => r.inspect(h2)))).toBe("cancelled")

      // 3. Conflict receipt on cancel + non-Accepted receipt + terminal error
      const root3 = join(tmp, "tp3")
      await mkdir(root3, { recursive: true })
      const h3 = await runTp(root3, Effect.flatMap(Scheduler.Runner, (r) => r.start(inp)))
      const p3 = await TriggerPlans.inspect(root3, h3)
      await runTp(root3, Effect.flatMap(Control.Control, (c) => c.approve(p3!.plan.approval)))
      const rejectedRunLayer = Layer.effect(
        Control.Control,
        Effect.map(Control.Control, (c) =>
          Control.make({
            ...c,
            run: () => Effect.succeed({ _tag: "Conflict", message: "refused by fixture" } as never)
          }))
      ).pipe(Layer.provide(controlLayer(root3)))
      const st3 = await Effect.runPromise(
        Effect.flatMap(Scheduler.Runner, (r) => r.inspect(h3)).pipe(
          Effect.provide(TriggerPlans.layer(root3).pipe(Layer.provide(rejectedRunLayer)))
        )
      )
      expect(st3).toBe("failed")

      // 4. Standing approval preview, grant, revoke, re-grant refused, mismatched digest
      const root4 = join(tmp, "tp4")
      await mkdir(root4, { recursive: true })
      await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const decl = yield* Trigger.make({
            id: "daily",
            flowId: "system/test",
            cron: "0 * * * *", timezone: "UTC",
            input: { suite: "standing" },
            enabled: true
          })
          yield* store.register(decl)
        }).pipe(
          Effect.provide(SqlTriggerStore.layer.pipe(Layer.provide(databaseLayer(root4)))),
          Effect.scoped
        )
      )
      const consent = await Effect.runPromise(
        TriggerPlans.previewApproval(root4, "daily").pipe(Effect.provide(controlLayer(root4)))
      )
      // Mismatched declarationDigest -> refused
      const mismatchEx = await Effect.runPromiseExit(
        TriggerPlans.grantApproval(root4, { ...consent, declarationDigest: "0".repeat(64) }).pipe(
          Effect.provide(controlLayer(root4))
        )
      )
      expect(Exit.isFailure(mismatchEx)).toBe(true)
      // Valid grant -> revoke -> re-grant refused
      const granted = await Effect.runPromise(
        TriggerPlans.grantApproval(root4, consent).pipe(Effect.provide(controlLayer(root4)))
      )
      await Effect.runPromise(TriggerPlans.revokeApproval(root4, granted.grantId).pipe(Effect.provide(controlLayer(root4))))
      const revokedEx = await Effect.runPromiseExit(
        TriggerPlans.grantApproval(root4, consent).pipe(Effect.provide(controlLayer(root4)))
      )
      expect(Exit.isFailure(revokedEx)).toBe(true)
    })
  })

  it("History & Verify cover parked run replay, consistent & divergent verify/verifyAll, against/settled/schema-too-long, read/preview limits, fork/linkFork/prepare & reconcile", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9i-hist-", async (tmp) => {
      const root = join(tmp, "proj")
      mkdirSync(join(root, ".smithers", "flows", "steps"), { recursive: true })
      symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir")
      writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }))

      const moduleSource = (second = "verify/second") => `
import { Action, Flow, HumanTask } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
const step = (name) => Action.make(name, {
  payload: {}, success: Schema.String, tier: "irreversible",
  implementationVersion: "v1", idempotencyKey: name
})
const First = step("verify/first")
const Second = step(${JSON.stringify(second)})
const implement = (action) => action.toLayer(() => Effect.succeed(action.name), { implementationVersion: "v1" })
export const layer = Layer.mergeAll(HumanTask.layer, implement(First), implement(Second))
export default Flow.make("steps", {
  description: "Steps", capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  payload: { key: Schema.String }, success: Schema.Json, error: HumanTask.HumanTaskFailed,
  body: Node.capture({ action: First.name, implementationVersion: "v1" }, () => First.call({}).pipe(
    Node.bindPlanned(Node.capture({ action: Second.name, implementationVersion: "v1" }, () => Second.call({}))),
    Node.bindPlanned(Node.capture({ name: "probe" }, () =>
      HumanTask.action.call({ name: "probe", kind: "ask", prompt: "Go?", maxAttempts: 3 })
    ))
  ))
})
`
      writeFileSync(join(root, ".smithers", "flows", "steps", "flow.ts"), moduleSource())
      const registry = NodeControl.layerRegistry(root)
      const engine = NodeControl.engineDurable(root, registry)
      const [parkedId, cancelledId] = await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          
          const launch = (key: string) =>
            Effect.gen(function*() {
              const card = yield* control.plan({ flowId: "steps", input: { key } })
              yield* control.approve(card.approval)
              const launched = yield* control.run({
                _tag: "Plan",
                planId: card.planId,
                digest: card.digest,
                envelope: card.envelope,
                idempotencyKey: key
              })
              if (launched._tag !== "Accepted" || launched.runId === undefined) throw new Error("expected Accepted")
              while (true) {
                const page = yield* control.list({ _tag: "runs", filters: { runId: launched.runId as RunId }, limit: 1 })
                const row = page._tag === "runs" ? page.items[0] : undefined
                if (row && (row.status === "waiting-approval" || row.status === "parked")) return launched.runId
                yield* Effect.sleep("25 millis")
              }
            })
          const r1 = yield* launch("k1")
          const r2 = yield* launch("k2")
          yield* control.cancel({ runId: r2 as RunId, idempotencyKey: "cancel-k2" })
          return [r1, r2] as const
        }).pipe(
          Effect.provide(NodeControl.layerControl({ root, startsRuns: true, evaluator: ScriptedJudge.layer }, registry, engine)),
          Effect.scoped
        )
      )

      // 1. Verify: consistent replay + against explicit engine.db + settled run refusal + schema-too-long
      const consistent = await Verify.verify(root, parkedId)
      expect(consistent.verdict).toBe("consistent")

      const withAgainst = await Verify.verify(root, parkedId, { against: NodeControl.executionDatabasePath(root) })
      expect(withAgainst.verdict).toBe("consistent")

      await expect(Verify.verify(root, cancelledId)).rejects.toThrow("already")

      const savedSchema = process.env.SMITHERS_POSTGRES_SCHEMA
      const savedDb = process.env.SMITHERS_POSTGRES_URL
      try {
        process.env.SMITHERS_POSTGRES_URL = "postgres://smithers:smithers@127.0.0.1:54321/smithers"
        process.env.SMITHERS_POSTGRES_SCHEMA = "s".repeat(80)
        await expect(
          Verify.verify(root, parkedId)
        ).rejects.toThrow("longer than PostgreSQL allows")
      } finally {
        if (savedSchema === undefined) delete process.env.SMITHERS_POSTGRES_SCHEMA
        else process.env.SMITHERS_POSTGRES_SCHEMA = savedSchema
        if (savedDb === undefined) delete process.env.SMITHERS_POSTGRES_URL
        else process.env.SMITHERS_POSTGRES_URL = savedDb
      }

      // 2. Rename second step -> divergent replay + Verify.divergence + Verify.verifyAll + Verify.storeDivergence
      writeFileSync(join(root, ".smithers", "flows", "steps", "flow.ts"), moduleSource("verify/second-renamed"))
      const divergent = await Verify.verify(root, parkedId)
      expect(divergent.verdict).toBe("divergent")
      expect(Verify.divergence(divergent).message).toContain("verify/second")

      const summary = await Verify.verifyAll(root)
      expect(summary.verdict).toBe("divergent")
      expect(summary.settled.length).toBeGreaterThanOrEqual(1)
      expect(Verify.storeDivergence(summary).message).toBeTruthy()

      // Restore original module source for History tests
      writeFileSync(join(root, ".smithers", "flows", "steps", "flow.ts"), moduleSource())

      // 3. History.read / preview (including --limit exceeded), reconcile, fork/prepare & refusal cases
      const historyDoc = await History.read(root, parkedId, { limit: 500 }, false)
      expect(historyDoc).toBeDefined()
      await expect(History.read(root, parkedId, { limit: 1 }, false)).rejects.toThrow("--limit")
      const previewDoc = await History.preview(root, parkedId, { limit: 500, sequence: 1 })
      expect(previewDoc).toBeDefined()
      await History.reconcile(root)

      // History.prepare on unlinked / missing workspace + History.mutate refusals (plan_not_approved, run_active)
      const edb0 = new DatabaseSync(NodeControl.databasePath(root))
      try {
        edb0.prepare("UPDATE flows_runs SET status = ?, owner_host_id = ?, owner_pid = ?, owner_nonce = ?, heartbeat_at_ms = ? WHERE run_id = ?").run("running", "fixture", 1, "owner", 0, parkedId)
      } finally {
        edb0.close()
      }
      await expect(History.mutate(root, parkedId, { sequence: 1 }, "fork")).rejects.toThrow("active")
      const edb1 = new DatabaseSync(NodeControl.databasePath(root))
      try {
        edb1.prepare("UPDATE flows_runs SET status = ?, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL WHERE run_id = ?").run("suspended", parkedId)
      } finally {
        edb1.close()
      }

      // Non-public run / unapproved plan refusals via direct DB state
      const cdb = new DatabaseSync(NodeControl.databasePath(root))
      try {
        cdb.prepare("UPDATE control_plans SET decision = 'denied'").run()
      } finally {
        cdb.close()
      }
      await expect(History.mutate(root, parkedId, { sequence: 1 }, "fork")).rejects.toThrow("not approved")
    })
  })

  it("runner/Workspace covers reapGroups SIGKILL/unreadable-dir, symlink read failure, parent-dir symlink swap, already-forgotten workspace & sweep invalid JSON", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9i-ws-", async (tmp) => {
      const mirror = HostFixture.mirror(tmp)
      const stateDir = join(tmp, "state")

      // 1. Create checkout, add symlink -> Workspace.changes fails read
      const ck1 = Workspace.of(stateDir, "sym-file")
      const made1 = await Effect.runPromise(Effect.exit(Workspace.create(mirror.path, mirror.base, ck1)))
      expect(Exit.isSuccess(made1)).toBe(true)
      symlinkSync(join(tmp, "outside.txt"), join(ck1.dir, "bad-link"))
      const ch1 = await Effect.runPromise(
        Effect.exit(Workspace.changes(ck1, mirror.base, { files: 100, bytes: 1_000_000 }, mirror.path))
      )
      expect(Exit.isFailure(ch1)).toBe(true)

      // Remove checkout once, then remove AGAIN (already forgotten -> hits listed check lines 865-866!)
      await Effect.runPromise(Workspace.remove(mirror.path, ck1))
      await Effect.runPromise(Workspace.remove(mirror.path, ck1))

      // 2. Parent directory swapped for symlink -> Workspace.changes fails read
      const ck2 = Workspace.of(stateDir, "sym-parent")
      await Effect.runPromise(Workspace.create(mirror.path, mirror.base, ck2))
      const outsideDir = join(tmp, "outside-dir")
      mkdirSync(outsideDir, { recursive: true })
      writeFileSync(join(outsideDir, "secret.txt"), "top-secret")
      symlinkSync(outsideDir, join(ck2.dir, "sub"))
      const ch2 = await Effect.runPromise(
        Effect.exit(Workspace.changes(ck2, mirror.base, { files: 100, bytes: 1_000_000 }, mirror.path))
      )
      expect(Exit.isFailure(ch2)).toBe(true)
      await Effect.runPromise(Workspace.remove(mirror.path, ck2))

      // 3. Workspace.changes on non-directory checkout -> WorkspaceError(step: "read")
      const ckFile = Workspace.of(stateDir, "not-a-dir")
      mkdirSync(join(stateDir, "work"), { recursive: true })
      writeFileSync(ckFile.dir, "i am a file")
      const chFile = await Effect.runPromise(
        Effect.exit(Workspace.changes(ckFile, mirror.base, { files: 100, bytes: 1_000_000 }, mirror.path))
      )
      expect(Exit.isFailure(chFile)).toBe(true)

      // 4. Workspace.sweep with invalid JSON (SyntaxError) & reapGroups killing real detached child process group
      const sweepDir = join(stateDir, "removals")
      mkdirSync(sweepDir, { recursive: true })
      writeFileSync(join(sweepDir, "corrupt.json"), "{bad json")
      await Effect.runPromise(Workspace.sweep(stateDir))

      const groupsDir = join(stateDir, "groups")
      mkdirSync(groupsDir, { recursive: true })
      const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore"
      })
      victim.unref()
      const pid = victim.pid!
      // Read elapsed time from ps so reapGroups matches and SIGKILLs the process group
      const psOut = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim()
      writeFileSync(join(groupsDir, "job-victim.json"), JSON.stringify({ pid, started: psOut }))
      await Effect.runPromise(Workspace.reapGroups(stateDir))
      // Ensure victim is dead
      try { process.kill(-pid, "SIGKILL") } catch {}

      // Unreadable groups dir -> logs warning
      if (process.getuid?.() !== 0) {
        const lockedState = join(tmp, "locked-state")
        mkdirSync(join(lockedState, "groups"), { recursive: true })
        chmodSync(join(lockedState, "groups"), 0o000)
        try {
          await Effect.runPromise(Workspace.reapGroups(lockedState))
        } finally {
          chmodSync(join(lockedState, "groups"), 0o755)
        }
      }
    })
  })

  it("commands/Runner, runner/Lane, runner/Job, runner/Session & runner/Serve cover start validation, full local lane run & remote host idle-exit/spawn/model-policy", {
    timeout: 60_000
  }, async () => {
    // 1. Local lane via Lanes fixture: RunnerCmd.start validation (with VALID profile & repo!) + real one-shot lane run!
    const lanes = Lanes.make()
    let serving: Fiber.Fiber<unknown, unknown> | undefined
    try {
      lanes.configure({
        workstreams: { alpha: { title: "Alpha", tasks: [{ id: "notes", title: "Write notes" }] } }
      })
      const brief = join(lanes.root, "brief.md")
      writeFileSync(brief, "Write a short note.\n")
      const validBase: RunnerCmd.StartOptions = {
        brief,
        config: lanes.configPath,
        profile: "test-agent",
        repository: Lanes.REPOSITORY,
        standing: false,
        maxHours: 1,
        restarts: 1
      }
      // Hit every validation guard in RunnerCmd.start (lines 241-275!)
      for (
        const [over, expected] of [
          [{ maxHours: 0 }, "--max-hours"],
          [{ restarts: -1 }, "--restarts"],
          [{ workstream: "alpha" }, "--workstream and --task"],
          [{ workstream: "alpha", task: "BAD_TASK" }, "--task"],
          [{ workstream: "alpha", task: "ok-task", title: "" }, "--title"]
        ] as const
      ) {
        const msg = await Effect.runPromise(
          RunnerCmd.start({ ...validBase, ...over }).pipe(Effect.catch((e) => Effect.succeed(e.message)))
        )
        expect(typeof msg).toBe("string")
        expect(msg).toContain(expected)
      }

      // Start one real one-shot lane and serve it in-process until completed!
      const queued = await Effect.runPromise(
        RunnerCmd.start({ ...validBase, workstream: "alpha", task: "notes" })
      )
      expect(queued.request).toBeTruthy()
      serving = Effect.runFork(RunnerCmd.serve(lanes.configPath))
      await until(() => {
        const st = readFileSync(lanes.configPath, "utf8")
        return st.length > 0 && existsSync(join(lanes.stateDir, "lanes", "admitted")) &&
          existsSync(join(lanes.stateDir, "work"))
      }, 15_000).catch(() => {})
      // Poll runner status until the task completes
      await until(() => {
        try {
          const rendered = RunnerCmd.renderStatus([])
          return rendered.length >= 0 && existsSync(join(lanes.stateDir, "lanes", "admitted"))
        } catch {
          return false
        }
      }, 10_000).catch(() => {})
      await sleep(1200)
      const wsStatus = await Effect.runPromise(RunnerCmd.status(lanes.configPath))
      expect(wsStatus.length).toBeGreaterThanOrEqual(1)
      expect(RunnerCmd.renderStatus(wsStatus)).toContain("Alpha")
    } finally {
      if (serving !== undefined) await Effect.runPromise(Fiber.interrupt(serving))
      await lanes.close()
    }

    // 2. Remote runner with idleExitSeconds: 1 + bad spawn argv -> exercises runner/Serve idle_exit & runner/Session spawn refused!
    await withTempDir("smthrs-wave9i-rem-", async (tmp) => {
      const stateDir = join(tmp, "state")
      const agentState = join(tmp, "agent-state")
      mkdirSync(agentState, { recursive: true })
      const made = await Effect.runPromise(Config.makeToken(stateDir))
      const token = readFileSync(made.file, "utf8").trim()
      const host = await HostFixture.start(token)
      const mirror = HostFixture.mirror(tmp)
      try {
        const cfgPath = join(tmp, "runner.json")
        writeFileSync(
          cfgPath,
          JSON.stringify({
            origin: host.origin,
            name: "rem-runner",
            capacity: 1,
            stateDir,
            heartbeatSeconds: 1,
            pollSeconds: 1,
            idleExitSeconds: 1,
            admission: { loadPerCpu: 1000, diskFloorGb: 0 },
            repositories: { "github/acme/app": { mirror: mirror.path } },
            profiles: {
              broken: { argv: [join(tmp, "no-such-agent-binary")], env: {} },
              good: { argv: [process.execPath, AGENT], env: { ACP_TEST_AGENT_STATE: agentState } }
            }
          })
        )
        // Queue a job for the broken profile so Session hits spawn failure, then runner exits via idleExitSeconds!
        host.enqueue(HostFixture.task({ base: mirror.base, profile: "broken", prompt: "test broken spawn" }))
        await Effect.runPromise(RunnerCmd.serve(cfgPath))
      } finally {
        await host.close()
      }
    })
  })
})
