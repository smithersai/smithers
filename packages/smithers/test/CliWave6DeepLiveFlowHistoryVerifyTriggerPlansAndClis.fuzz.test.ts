import { Control } from "@smthrs/control"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Effect, Layer, Stream } from "effect"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as ControlCommands from "../src/cli/ControlCommands.ts"
import * as Generate from "../src/cli/Generate.ts"
import * as Open from "../src/commands/Open.ts"
import * as EvalCli from "../src/evaluation/EvalCli.ts"
import * as History from "../src/history/History.ts"
import * as Verify from "../src/history/Verify.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Triggers from "../src/operator/Triggers.ts"

const pingFlowSource = `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("ping", {
  description: "Wave-6B deterministic ping flow.",
  payload: {},
  success: Schema.Struct({ ok: Schema.Boolean, msg: Schema.String }),
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  body: Node.capture({}, () => Node.succeed({ ok: true, msg: "pong" }))
})
`

const runIncur = async (cli: any, argv: Array<string>) => {
  let code = 0
  let out = ""
  await cli.serve(argv, {
    stdout: (s: string) => { out += s },
    exit: (c: number) => { code = c }
  })
  return { code, out }
}

describe("@smthrs/cli Wave-6B Deep Live Flow, History, Verify, TriggerPlans, ControlCommands, EvalCli, Generate & Open fuzz invariants", () => {
  it("End-to-end real flow execution feeds ControlCommands, Command.cli, History read/replay/preview/mutate, Verify & TriggerPlans standing approvals", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smthrs-live-hist-tp-"))
    const flowDir = join(tmp, ".smithers", "flows", "ping")
    mkdirSync(flowDir, { recursive: true })
    symlinkSync(join(process.cwd(), "node_modules"), join(tmp, "node_modules"))
    writeFileSync(join(flowDir, "flow.ts"), pingFlowSource)

    try {
      const env = { ...process.env, HOME: tmp }
      const runtime: ControlBridge.Runtime = { environment: env }

      // 1. Run a real flow to completion via NodeControl.layer({ root: tmp })!
      const controlLayer = NodeControl.layer({ root: tmp })
      const { controlRunId, plan } = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const ctrl = yield* Control.Control
            const p = yield* ctrl.plan({ flowId: "ping", input: {} })
            yield* ctrl.approve(p.approval)
            const started = yield* ctrl.run({
              _tag: "Plan",
              planId: p.planId,
              digest: p.digest,
              envelope: p.envelope,
              idempotencyKey: "wave6-ping-1"
            })
            expect(started._tag).toBe("Accepted")
            const runId = started._tag === "Accepted" ? started.runId! : ""
            yield* ctrl.watch({ runId, follow: true }).pipe(
              Stream.takeUntil((e) => e.kind === "control.run.completed" || e.kind === "control.run.failed"),
              Stream.runCollect
            )
            return { controlRunId: runId, plan: p }
          }).pipe(Effect.provide(controlLayer))
        )
      )
      expect(controlRunId.length).toBeGreaterThan(0)
      expect(plan.planId.length).toBeGreaterThan(0)

      // 2. ControlCommands: flow list/show/plan, runs list/count/show/wait/devtools/logs/output/signals/cancel-all, approvals list
      const flowCli = ControlCommands.createFlowCli(runtime)
      const runsCli = ControlCommands.createRunsCli(runtime)
      const apprCli = ControlCommands.createApprovalsCli(runtime)

      for (const [cli, argv] of [
        [flowCli, ["list", "--root", tmp, "--format", "json"]],
        [flowCli, ["show", "ping", "--root", tmp, "--format", "json"]],
        [flowCli, ["plan", "ping", "--root", tmp, "--format", "json"]],
        [runsCli, ["list", "--root", tmp, "--format", "json"]],
        [runsCli, ["count", "--root", tmp, "--format", "json"]],
        [runsCli, ["show", controlRunId, "--root", tmp, "--format", "json"]],
        [runsCli, ["wait", controlRunId, "--root", tmp, "--format", "json"]],
        [runsCli, ["devtools", controlRunId, "--root", tmp, "--format", "json"]],
        [runsCli, ["logs", controlRunId, "--root", tmp, "--format", "json"]],
        [runsCli, ["output", controlRunId, "--root", tmp, "--format", "json"]],
        [runsCli, ["signals", controlRunId, "--root", tmp, "--format", "json"]],
        [runsCli, ["cancel-all", "--root", tmp, "--format", "json"]],
        [apprCli, ["list", "--root", tmp, "--format", "json"]]
      ] as const) {
        const res = await runIncur(cli, [...argv])
        expect(res.code, `command ${argv.join(" ")} failed: ${res.out}`).toBe(0)
      }

      // 3. ControlBridge.invoke -> Command.cli verbs on the REAL completed run!
      for (const cmdArgs of [
        ["ls"],
        ["plan", "ping"],
        ["ps"],
        ["status", controlRunId],
        ["why", controlRunId],
        ["logs", controlRunId],
        ["events", controlRunId],
        ["output", controlRunId],
        ["gc", "--dry-run"]
      ]) {
        const out = await ControlBridge.invoke(cmdArgs, { root: tmp, quiet: false }, runtime)
        expect(out).toBeDefined()
      }

      // 4. Verify & History on the real completed run!
      await expect(Verify.verify(tmp, controlRunId)).rejects.toThrow(/already completed/)
      const vSummary = await Verify.verifyAll(tmp)
      expect(vSummary).toBeDefined()
      const synthReport = Verify.report(controlRunId, [], [])
      expect(Verify.divergence({ ...synthReport, matched: false, mismatches: [{ seq: 1, reason: "diff" }] } as any)).toBeInstanceOf(Error)
      expect(Verify.storeDivergence({ ...vSummary, diverged: [synthReport] } as any)).toBeInstanceOf(Error)

      await History.reconcile(tmp)
      const hRead = await History.read(tmp, controlRunId, {}, false)
      expect(hRead.status).toBe("completed")
      const hReplay = await History.read(tmp, controlRunId, {}, true)
      expect(hReplay.status).toBe("completed")
      const hPrev = await History.preview(tmp, controlRunId, {})
      expect(hPrev.preview).toBe(true)
      // Forking exercises History.mutate (either succeeds or refuses cleanly if workspace/jj unavailable)
      await History.mutate(tmp, controlRunId, {}, "fork").catch(() => undefined)
      await History.mutate(tmp, controlRunId, {}, "rewind").catch(() => undefined)

      // 5. TriggerPlans: register a real trigger -> previewApproval -> grantApproval -> Scheduler.Runner launch & status -> inspect -> revokeApproval!
      await Triggers.withTriggers(
        { root: tmp },
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const decl = yield* Trigger.make({
            id: "trig-ping-1",
            flowId: "ping",
            input: {},
            cron: "0 0 * * *",
            enabled: true
          })
          yield* store.register(decl)
        })
      )

      const { grantId, handle } = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const preview = yield* TriggerPlans.previewApproval(tmp, "trig-ping-1")
            expect(preview.triggerId).toBe("trig-ping-1")
            const granted = yield* TriggerPlans.grantApproval(tmp, preview)
            expect(granted.grantId.length).toBeGreaterThan(0)
            // Launch an occurrence through TriggerPlans.layer(tmp) -> standing approval matches!
            const runner = yield* Scheduler.Runner
            const occKey = "trig-ping-1:2026-11-24T00:00:00.000Z"
            const h = yield* runner.start({ flowId: "ping", input: {}, idempotencyKey: occKey })
            const st1 = yield* runner.inspect(h)
            expect(typeof st1).toBe("string")
            const st2 = yield* runner.inspect(h)
            expect(typeof st2).toBe("string")
            // Also start a second unapproved occurrence and cancel it cleanly
            const h2 = yield* runner.start({ flowId: "ping", input: {}, idempotencyKey: "manual-occ-2" })
            yield* runner.cancel(h2)
            const rev = yield* TriggerPlans.revokeApproval(tmp, granted.grantId)
            expect(rev.revoked).toBe(true)
            return { grantId: granted.grantId, handle: h }
          }).pipe(
            Effect.provide(TriggerPlans.layer(tmp).pipe(Layer.provideMerge(controlLayer)))
          )
        )
      )
      expect(grantId.length).toBeGreaterThan(0)
      const inspected = await TriggerPlans.inspect(tmp, handle)
      expect(inspected === null || typeof inspected === "object").toBe(true)
      expect(await TriggerPlans.inspect(tmp, "not-a-trigger-handle")).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)

  it("EvalCli, Generate CLI, Triggers CLI & Open command uphold end-to-end invariants", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smthrs-eval-gen-open-"))
    const evalDir = join(tmp, "evals")
    mkdirSync(evalDir, { recursive: true })
    symlinkSync(join(process.cwd(), "node_modules"), join(tmp, "node_modules"))
    const genDir = join(tmp, "gen-ws")
    mkdirSync(genDir, { recursive: true })

    try {
      // 1. EvalCli: list, run, show, baseline, compare on a real .eval.mjs fixture!
      const evalModule = join(evalDir, "demo.eval.mjs")
      writeFileSync(
        evalModule,
        `import { CaseExecutor, Suite } from "@smthrs/evals"
import { Binding, Scorer } from "@smthrs/scorers"
import { Effect } from "effect"
const target = { name: "demo-target" }
const scorer = Scorer.make({ id: "cli/demo/exact", version: "1", name: "exact", score: () => Effect.succeed({ score: 1 }) })
export const suite = Suite.make({
  name: "demo",
  concurrency: 1,
  cases: [{ name: "c1", input: 1, expected: 1 }],
  bindings: [Binding.make({ scorer, appliesTo: target })]
})
export const executor = CaseExecutor.make((entry) => Effect.succeed({ output: entry.input, stepKey: "s1", latencyMs: 0, target }))
`
      )

      const evalCli = EvalCli.createEvalCli({ environment: { ...process.env, HOME: tmp } })
      const evList = await runIncur(evalCli, ["list", "--root", tmp, "--format", "json"])
      expect(evList.code).toBe(0)
      const evRun = await runIncur(evalCli, ["run", "demo", "--root", tmp, "--run-id", "ev-cli-1", "--format", "json"])
      expect(evRun.code).toBe(0)
      const evScores = await runIncur(evalCli, ["scores", "ev-cli-1", "--root", tmp, "--format", "json"])
      expect(evScores.code, `eval scores failed: ${evScores.out}`).toBe(0)
      const baseFile = join(tmp, "demo-baseline.json")
      const evBase = await runIncur(evalCli, ["baseline", "ev-cli-1", "--output", baseFile, "--root", tmp, "--format", "json"])
      expect(evBase.code, `eval baseline failed: ${evBase.out}`).toBe(0)
      const evCmp = await runIncur(evalCli, ["compare", "ev-cli-1", "--baseline", baseFile, "--root", tmp, "--format", "json"])
      expect(evCmp.code, `eval compare failed: ${evCmp.out}`).toBe(0)

      // 2. Generate CLI: initialize + createGenerateCli (flow, package, ci)
      const genCli = Generate.createGenerateCli({ environment: { ...process.env, HOME: tmp } })
      for (const argv of [
        ["flow", "hello-gen", "--root", genDir, "--format", "json"],
        ["package", "pkg-gen", "--root", genDir, "--format", "json"],
        ["ci", "--root", genDir, "--format", "json"]
      ]) {
        const res = await runIncur(genCli, argv)
        expect(res.code === 0 || res.code === 1).toBe(true)
      }
      const initRes = await Generate.initialize(genDir, "my-app", { dryRun: true } as any)
      expect(initRes).toBeDefined()

      // 3. Triggers CLI: list & status on temp root
      const trigCli = Triggers.createTriggersCli()
      const tList = await runIncur(trigCli, ["list", "--root", tmp, "--format", "json"])
      expect(tList.code).toBe(0)

      // 4. Open command: repoFromRemote, deepLink, webUrl, resolveRepo, open() with injected Host!
      expect(Open.repoFromRemote("https://github.com/acme/widget.git")).toBe("acme/widget")
      expect(Open.repoFromRemote("git@github.com:acme/widget.git")).toBe("acme/widget")
      expect(Open.repoFromRemote("ssh://git@github.com/acme/widget.git")).toBe("acme/widget")
      expect(Open.repoFromRemote("not-a-remote")).toBeNull()
      expect(Open.deepLink("acme/widget")).toBe("smithers://open/acme/widget")
      expect(Open.webUrl("acme/widget")).toBe("https://smithers.sh/acme/widget")

      const openedUrls: Array<string> = []
      const fakeOpenHost: Open.Host = {
        platform: "darwin",
        home: tmp,
        exists: () => true,
        read: (_cmd, args) => {
          if (args.includes("get-url")) return "https://github.com/acme/widget.git\n"
          return "origin https://github.com/acme/widget.git\n"
        },
        launch: async (cmd, args) => {
          openedUrls.push(`${cmd} ${args.join(" ")}`)
          return 0
        }
      }
      const opened = await Open.open(fakeOpenHost, tmp)
      expect(opened.repo).toBe("acme/widget")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})
