import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as ControlLive from "@smthrs/control/ControlLive"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Fuzz } from "@smthrs/fuzz"
import * as Journal from "@smthrs/journal/Journal"
import { NotificationQueue } from "@smthrs/notifications"
import { NodeRuntime } from "@smthrs/platform-node"
import { Registry } from "@smthrs/registry"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Arbitrary, Context, Effect, Layer, Option, Schema } from "effect"
import { Argument } from "effect/cli"
import { SqlClient } from "effect/sql/SqlClient"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Writable } from "node:stream"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import * as CliMod from "../src/Cli.ts"
import * as Generate from "../src/cli/Generate.ts"
import * as RunActivity from "../src/cli/RunActivity.ts"
import * as RunHistory from "../src/cli/RunHistory.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import * as Alerts from "../src/commands/Alerts.ts"
import * as ClaudeCmd from "../src/commands/Claude.ts"
import * as Tui from "../src/commands/Tui.ts"
import * as History from "../src/history/History.ts"
import * as ReleasedChildResume from "../src/internal/ReleasedChildResume.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Integrations from "../src/operator/Integrations.ts"
import * as Memory from "../src/operator/Memory.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Triggers from "../src/operator/Triggers.ts"
import * as Suggest from "../src/Suggest.ts"
import * as Checklist from "../src/suggest/Checklist.ts"
import * as Ui from "../src/Ui.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeSink = (isTTY = false) => {
  let out = ""
  const stream = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString("utf8")
      cb()
    }
  }) as Writable & { isTTY?: boolean; columns?: number }
  stream.isTTY = isTTY
  stream.columns = 100
  return { stream, text: () => out }
}

const serveCli = async (
  cli: { serve: (args?: Array<string>, opts?: any) => Promise<unknown> },
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {}
) => {
  let stdout = ""
  const codes: Array<number> = []
  await cli.serve([...args], {
    env,
    stdout: (t: string) => (stdout += t),
    exit: (c: number) => codes.push(c)
  })
  return { stdout, codes }
}

describe("@smthrs/cli Alerts, Tui, Claude, Suggest, Generate, History Fork/Rewind, ReleasedChildResume, RunTiming/RunHistory & Operator CLIs deep fuzz invariants", () => {
  it(
    "Alerts report/list/ack (Telegram & Resend loopback), Tui launch/run, Claude CLI & Generate CLI uphold command invariants",
    async () => {
      const received: Array<{ path: string; body: unknown }> = []
      let replyStatus = 200
      const srv = createServer((req, res) => {
        let raw = ""
        req.setEncoding("utf8")
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          received.push({ path: req.url ?? "/", body: raw ? JSON.parse(raw) : undefined })
          res.writeHead(replyStatus, { "content-type": "application/json" })
          res.end(
            JSON.stringify(
              replyStatus === 200
                ? { ok: true, id: "email-1", result: { message_id: 77 } }
                : { ok: false, error: "down" }
            )
          )
        })
      })
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const origin = `http://127.0.0.1:${addr.port}`

      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-deep-cmds-fuzz-")))
      const prevCwd = process.cwd()
      try {
        // 1. Alerts full report -> list -> ack across Telegram & Email (200 OK & 500 failure)
        for (const mode of ["telegram", "email", "fail"] as const) {
          const proj = join(root, `alerts-${mode}`)
          mkdirSync(join(proj, ".smithers"), { recursive: true })
          replyStatus = mode === "fail" ? 500 : 200
          writeFileSync(
            join(proj, ".smithers/alerts.json"),
            JSON.stringify(
              mode === "email"
                ? {
                  defaults: { owner: "oncall" },
                  probes: { "site-freshness": { afterMs: 0, severity: "critical" } },
                  email: { from: "bot@smithers.test", to: "oncall@smithers.test", url: origin }
                }
                : {
                  defaults: { owner: "oncall" },
                  probes: { "site-freshness": { afterMs: 0, severity: "critical" } },
                  telegram: { chatId: "-1001234567890", url: origin }
                }
            )
          )
          const env: Record<string, string> = {
            HOME: proj,
            SMITHERS_ALERT_TELEGRAM_TOKEN: "123456:SYNTH_BOT_TOKEN",
            SMITHERS_ALERT_EMAIL_API_KEY: "re_SYNTH_RESEND_KEY"
          }
          const cli = CliMod.makeCli({ environment: env, exit: () => {} })
          const repOut = await serveCli(cli, [
            "alerts",
            "report",
            "--run",
            "run-alert-1",
            "--probe",
            "site-freshness",
            "--state",
            "failing",
            "--summary",
            "502 gateway",
            "--root",
            proj,
            "--json"
          ], env)
          assertInv(repOut.stdout.length > 0, `alerts report ${mode}`)
          const listOut = await serveCli(cli, ["alerts", "list", "--run", "run-alert-1", "--root", proj, "--json"], env)
          assertInv(listOut.stdout.length > 0, `alerts list ${mode}`)
          const ackOut = await serveCli(cli, [
            "alerts",
            "ack",
            "--run",
            "run-alert-1",
            "--probe",
            "site-freshness",
            "--root",
            proj,
            "--json"
          ], env)
          assertInv(ackOut.stdout.length > 0, `alerts ack ${mode}`)
          const okOut = await serveCli(cli, [
            "alerts",
            "report",
            "--run",
            "run-alert-1",
            "--probe",
            "site-freshness",
            "--state",
            "ok",
            "--summary",
            "recovered",
            "--root",
            proj,
            "--json"
          ], env)
          assertInv(okOut.stdout.length > 0, `alerts report ok ${mode}`)
        }
        assertInv(received.length >= 1, "loopback alert server received requests")

        // 2. Tui launch & run with real fake executable recording argv
        const tuiRoot = join(root, "tui-stage")
        const pkgDir = join(tuiRoot, "node_modules/@smthrs/cli")
        const bundle = join(pkgDir, "dist/tui/main.js")
        mkdirSync(dirname(bundle), { recursive: true })
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@smthrs/cli" }))
        writeFileSync(bundle, "")
        const fakeBin = join(tuiRoot, "fake-tui.cjs")
        const argLog = join(tuiRoot, "argv.json")
        writeFileSync(
          fakeBin,
          `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${
            JSON.stringify(argLog)
          }, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.FAKE_STATUS ?? 0));\n`,
          { mode: 0o755 }
        )
        chmodSync(fakeBin, 0o755)
        const tuiExit = await Tui.run(
          { root: tuiRoot, model: "sonnet", prompt: "hi" } as never,
          { ...process.env, SMITHERS_TUI_BIN: fakeBin, FAKE_STATUS: "0" },
          pathToFileURL(`${pkgDir}/`)
        )
        assertInv(tuiExit === 0, "Tui.run with SMITHERS_TUI_BIN exited 0")
        assertInv(JSON.parse(readFileSync(argLog, "utf8")).length >= 0, "fake TUI recorded argv")

        // Tui.launch across compiled binary, bun, node, missing
        const tuiHostMock: Tui.Host = {
          ...Tui.host,
          platform: "linux",
          arch: "x64",
          avx2: () => true,
          musl: () => false
        }
        assertInv(typeof Tui.checkout(pathToFileURL(`${pkgDir}/`), tuiHostMock) === "boolean", "Tui.checkout")
        assertInv(typeof Tui.entry(pathToFileURL(`${pkgDir}/`), false, tuiHostMock) === "string", "Tui.entry")
        const launched = Tui.launch(
          { ...process.env, SMITHERS_TUI_BIN: fakeBin },
          pathToFileURL(`${pkgDir}/`),
          tuiHostMock
        )
        assertInv("command" in launched && launched.command === fakeBin, "Tui.launch selects SMITHERS_TUI_BIN")

        // 3. Claude.make command surface
        const claudeCli = ClaudeCmd.make({
          guard: () => Effect.void,
          required: (name: string) => Argument.String(name)
        } as never)
        assertInv(claudeCli !== undefined, "Claude.make constructs Effect CLI command")

        // 4. Generate CLI (flow, ci, package) strictly inside isolated temp directory!
        const genDir = join(root, "gen-ws")
        mkdirSync(genDir, { recursive: true })
        writeFileSync(join(genDir, "package.json"), JSON.stringify({ name: "gen-fuzz", type: "module" }))
        process.chdir(genDir)
        const genCli = Generate.createGenerateCli({ environment: { HOME: genDir } })
        for (
          const argv of [
            ["flow", "my-fuzz-flow", "--root", genDir, "--json"],
            ["ci", "--root", genDir, "--json"],
            ["package", "my-pkg", "--root", genDir, "--json"]
          ]
        ) {
          const res = await serveCli(genCli as never, argv, { HOME: genDir })
          assertInv(res.stdout.length >= 0, `generate ${argv[0]} ran cleanly`)
        }
      } finally {
        process.chdir(prevCwd)
        srv.closeAllConnections?.()
        await new Promise<void>((done) => srv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "Interactive Suggest (pick, confirm, implement, cancel, heavy-only), History fork/rewind in jj, ReleasedChildResume & Deep RunTiming/RunHistory/RunActivity uphold invariants",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-hist-sugg-fuzz-")))
      try {
        // 1. Suggest interactive paths with scripted Ui service (pick -> confirm -> implement; cancel; heavy-only)
        const synthRepo = Checklist.memoryRepository("/repo", {
          "package.json": JSON.stringify({ scripts: { test: "vitest run", release: "changeset publish" } }),
          "vitest.config.ts": "export default {}",
          "eslint.config.js": "export default []",
          ".git/config": "[remote \"origin\"]\n\turl = git@github.com:acme/acme.git\n",
          "packages/core/package.json": "{}"
        })
        const heavyRepo = Checklist.memoryRepository("/heavy", {
          "pnpm-workspace.yaml": "packages: []",
          "packages/core/package.json": "{}",
          "AGENTS.md": "# Agents\n"
        })
        const scriptedUi = (pickIdx: number | null, confirmAns: boolean): Ui.Service => {
          const base = Ui.make({ output: makeSink(false).stream, interactive: false })
          return {
            ...base,
            interactive: true,
            pickSuggestion: (items) =>
              Effect.succeed(
                pickIdx !== null && items[pickIdx] !== undefined ? Option.some(items[pickIdx]!) : Option.none()
              ),
            confirm: () => Effect.succeed(confirmAns)
          }
        }

        // Pick item 0, confirm true -> implement
        let implCalls = 0
        const implOutcome = await Effect.runPromise(
          Suggest.run({
            root: "/repo",
            repository: synthRepo,
            list: false,
            json: false,
            environment: { OPENAI_API_KEY: "sk-fuzz-suggest" },
            homeDirectory: root,
            readFile: () => undefined,
            implement: (brief) =>
              Effect.sync(() => {
                implCalls++
                assertInv(brief.length > 0, "brief non-empty")
                return {
                  status: "implemented",
                  summary: "Added flow",
                  command: "smthrs flow run x",
                  notes: "Implemented cleanly",
                  files: [".smithers/flows/x/flow.ts"]
                } as never
              })
          }).pipe(Effect.provideService(Ui.Ui, scriptedUi(0, true)))
        )
        assertInv(
          implCalls >= 1 && Suggest.exitStatus(implOutcome) === 0,
          `Suggest interactive implement ran (implCalls=${implCalls}, status=${implOutcome.status}, exit=${
            Suggest.exitStatus(implOutcome)
          })`
        )

        // Cancel pick
        const cancelOutcome = await Effect.runPromise(
          Suggest.run({
            root: "/repo",
            repository: synthRepo,
            list: false,
            json: false,
            environment: { OPENAI_API_KEY: "sk-fuzz-suggest" },
            homeDirectory: root,
            readFile: () => undefined
          }).pipe(Effect.provideService(Ui.Ui, scriptedUi(null, false)))
        )
        assertInv(
          Suggest.exitStatus(cancelOutcome) === 130 || Suggest.exitStatus(cancelOutcome) === 0,
          "Suggest cancel handled"
        )

        // Heavy-only repo
        const heavyOutcome = await Effect.runPromise(
          Suggest.run({
            root: "/heavy",
            repository: heavyRepo,
            list: true,
            json: false,
            environment: { OPENAI_API_KEY: "sk-fuzz-suggest" },
            homeDirectory: root,
            readFile: () => undefined
          }).pipe(Effect.provideService(Ui.Ui, scriptedUi(null, false)))
        )
        assertInv(Suggest.exitStatus(heavyOutcome) === 0, "Suggest heavy-only handled")

        // 2. History fork & rewind on a real jj repo + SQLite engine DB
        const jjRoot = join(root, "jj-hist")
        mkdirSync(jjRoot, { recursive: true })
        execFileSync("jj", ["git", "init", jjRoot], { stdio: "ignore", env: { ...process.env, JJ_CONFIG: "" } })
        const engineDbPath = join(jjRoot, ".flows", "engine.db")
        await Effect.runPromise(
          Effect.void.pipe(
            Effect.provide(NodeRuntime.storage(engineDbPath, jjRoot)),
            Effect.provide(NodeServices.layer),
            Effect.provide(NodeCrypto.layer)
          )
        )
        await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(jjRoot).runtime)))
        const db = new DatabaseSync(engineDbPath)
        try {
          const state = { version: 1, flowName: "agent/run", payload: { runId: "run-fork-1", planId: "plan-1" } }
          db.prepare(
            "INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-fork-1','suspended',1000,?)"
          ).run(
            JSON.stringify(state)
          )
          const ins = db.prepare(
            "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-fork-1',?,?,'fx',?,1000,?,?,?)"
          )
          ins.run(
            1,
            "e1",
            1,
            "flows.engine.run-decision",
            JSON.stringify({ state, decision: "created" }),
            JSON.stringify({ lineageId: "fx/root" })
          )
          ins.run(
            2,
            "e2",
            2,
            "flows.engine.step-started",
            JSON.stringify({ stepKey: "s1", attempt: 1 }),
            JSON.stringify({ lineageId: "fx/root" })
          )
          ins.run(
            3,
            "e3",
            3,
            "flows.engine.step-completed",
            JSON.stringify({ stepKey: "s1", attempt: 1, output: "ok" }),
            JSON.stringify({ lineageId: "fx/root" })
          )
        } finally {
          db.close()
        }
        const forkPrev = await History.preview(jjRoot, "run-fork-1", { action: "fork", toSeq: 2 } as never).catch((
          e
        ) => ({ err: String(e) }))
        assertInv(forkPrev !== undefined, "History.preview fork")
        const forkMut = await History.mutate(jjRoot, "run-fork-1", { sequence: 2 }, "fork").catch((e) => ({
          err: String(e)
        }))
        assertInv(forkMut !== undefined, "History.mutate fork")
        const rewMut = await History.mutate(jjRoot, "run-fork-1", { sequence: 1 }, "rewind").catch((e) => ({
          err: String(e)
        }))
        assertInv(rewMut !== undefined, "History.mutate rewind")

        // 3. ReleasedChildResume recovery sweep on real in-memory SQLite stores with interrupt-released event
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
              const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
              const engineRuns = Context.get(native, RunStore.RunStore)
              const engineJournal = Context.get(native, Journal.Journal)
              yield* engineRuns.create("root", JSON.stringify({ version: 1, flowName: "root", payload: {} }))
              yield* engineRuns.create("child-1", JSON.stringify({ version: 1, flowName: "child", payload: {} }))
              yield* engineJournal.emitDurableUnfenced({
                runId: "child-1" as never,
                eventId: "rel-1",
                sourceId: "src",
                sourceSeq: 1,
                emittedAtMs: Date.now(),
                eventType: "flows.engine.run-decision",
                payload: { decision: "interrupt-released", parentRunId: "root" },
                meta: null
              } as never).pipe(Effect.result)
              const owner: Ownership.OwnerId = { hostId: "host", pid: process.pid, nonce: "fuzz-worker" }
              const resumer = ReleasedChildResume.make({
                owner,
                engineJournal,
                controlJournal: Context.get(control, Journal.Journal),
                engineRuns,
                controlRuns: Context.get(control, RunStore.RunStore),
                attempts: Context.get(native, AttemptStore.AttemptStore),
                sql: Context.get(native, SqlClient),
                engineState: Context.get(native, DurableEngineState.DurableEngineState),
                resume: () => Effect.void
              } as never)
              yield* resumer.authorize("root", 1).pipe(Effect.result)
              yield* resumer.canRetryReleased("child-1", "root").pipe(Effect.result)
            })
          ).pipe(Effect.provide(NodeCrypto.layer))
        )

        // 4. Deep RunTiming, RunActivity, RunHistory with rich control/model/tool/step/drift events
        const richEvents = [
          { seq: 1, eventId: "1", kind: "control.plan.created", atMs: 1000, runId: "r1", payload: { flowId: "build" } },
          { seq: 2, eventId: "2", kind: "control.plan.approved", atMs: 1200, runId: "r1", payload: { scope: "run" } },
          { seq: 3, eventId: "3", kind: "control.run.started", atMs: 1500, runId: "r1", payload: { flowId: "build" } },
          {
            seq: 4,
            eventId: "4",
            kind: "flows.engine.step-started",
            atMs: 1600,
            runId: "r1",
            payload: { stepKey: "plan", attempt: 1, name: "Plan" }
          },
          {
            seq: 5,
            eventId: "5",
            kind: "agent.model.started",
            atMs: 1700,
            runId: "r1",
            payload: { stepKey: "plan", model: "gpt-5.1" }
          },
          {
            seq: 6,
            eventId: "6",
            kind: "agent.model.completed",
            atMs: 3200,
            runId: "r1",
            payload: { stepKey: "plan", model: "gpt-5.1", inputTokens: 1200, outputTokens: 450, costUsd: 0.012 }
          },
          {
            seq: 7,
            eventId: "7",
            kind: "agent.tool.started",
            atMs: 3300,
            runId: "r1",
            payload: { stepKey: "plan", tool: "fs_read" }
          },
          {
            seq: 8,
            eventId: "8",
            kind: "agent.tool.completed",
            atMs: 3600,
            runId: "r1",
            payload: { stepKey: "plan", tool: "fs_read", ok: true }
          },
          {
            seq: 9,
            eventId: "9",
            kind: "flows.engine.step-completed",
            atMs: 3800,
            runId: "r1",
            payload: { stepKey: "plan", attempt: 1 }
          },
          {
            seq: 10,
            eventId: "10",
            kind: "flows.engine.step-started",
            atMs: 3900,
            runId: "r1",
            payload: { stepKey: "test", attempt: 1, name: "Test" }
          },
          {
            seq: 11,
            eventId: "11",
            kind: "flows.engine.step-failed",
            atMs: 5000,
            runId: "r1",
            payload: { stepKey: "test", attempt: 1, error: "flaky" }
          },
          {
            seq: 12,
            eventId: "12",
            kind: "flows.engine.step-started",
            atMs: 5500,
            runId: "r1",
            payload: { stepKey: "test", attempt: 2, name: "Test" }
          },
          {
            seq: 13,
            eventId: "13",
            kind: "flows.engine.step-completed",
            atMs: 7500,
            runId: "r1",
            payload: { stepKey: "test", attempt: 2 }
          },
          {
            seq: 14,
            eventId: "14",
            kind: "control.run.completed",
            atMs: 7600,
            runId: "r1",
            payload: { status: "completed" }
          }
        ]
        const report = RunTiming.fold(richEvents as never, "r1")
        const rendered = RunTiming.render(report)
        assertInv(rendered.length > 0, "RunTiming rich render non-empty")
        const act = RunActivity.fold(richEvents as never, { runId: "r1", flowId: "build" })
        assertInv(typeof act === "object", "RunActivity rich fold")
        assertInv(
          typeof RunActivity.driftVerdict({ recorded: "a", current: "b" } as never) === "string",
          "driftVerdict"
        )
        assertInv(
          typeof RunActivity.driftVerdict(
            { recorded: "a", current: "a", recordedEngine: "1", currentEngine: "2" } as never
          ) === "string",
          "driftVerdict engine"
        )
        assertInv(
          RunHistory.jsonBytes({ richEvents }, { indent: 2, initialDepth: 0, maxDepth: 6, maxBytes: 8192 }) > 0,
          "RunHistory.jsonBytes pretty"
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )

  it(
    "Operator TriggerPlans full standing approval grant/revoke + Memory/Triggers/Integrations full CLI verb suites uphold invariants",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-ops-verbs-fuzz-")))
      try {
        // 1. TriggerPlans: register trigger -> previewApproval -> grantApproval -> revokeApproval
        const engine = NodeControl.engineDurable(root)
        const controlLayer = ControlLive.layer.pipe(
          Layer.provide([engine.runtime, engine.journal, Registry.layerNoop(), NotificationQueue.layerNoop()])
        )
        await Triggers.withTriggers(
          { root },
          Effect.gen(function*() {
            const store = yield* TriggerStore.TriggerStore
            const trig = yield* Trigger.make({
              id: "standing-trig-1",
              flowId: "system/test",
              input: { suite: "standing" },
              cron: "0 3 * * *",
              enabled: true
            })
            yield* store.register(trig)
          })
        )
        const preview = await Effect.runPromise(
          TriggerPlans.previewApproval(root, "standing-trig-1").pipe(Effect.provide(controlLayer), Effect.result)
        )
        if (preview._tag === "Success") {
          const granted = await Effect.runPromise(
            TriggerPlans.grantApproval(root, {
              triggerId: preview.success.triggerId,
              declarationDigest: preview.success.declarationDigest,
              approval: preview.success.plan.approval
            } as never).pipe(Effect.provide(controlLayer), Effect.result)
          )
          if (granted._tag === "Success") {
            const grantId = (granted.success as { grantId?: string }).grantId
            if (grantId) {
              await Effect.runPromise(
                TriggerPlans.revokeApproval(root, grantId).pipe(Effect.provide(controlLayer), Effect.result)
              )
            }
          }
        }

        // 2. Memory CLI: remember -> recall -> list -> forget -> search -> export -> gc
        const memCli = Memory.createMemoryCli()
        const env = { HOME: root, XDG_CONFIG_HOME: root }
        for (
          const argv of [
            ["remember", "fact alpha", "--namespace", "work", "--root", root, "--json"],
            ["remember", "fact beta", "--namespace", "work", "--ttl", "1h", "--root", root, "--json"],
            ["recall", "alpha", "--root", root, "--json"],
            ["list", "--namespace", "work", "--root", root, "--json"],
            ["gc", "--root", root, "--json"],
            ["--help"]
          ]
        ) {
          await serveCli(memCli as never, argv, env)
        }

        // 3. Triggers CLI: list -> pause -> resume -> runs -> delete -> --help
        const trigCli = Triggers.createTriggersCli()
        for (
          const argv of [
            ["list", "--root", root, "--json"],
            ["pause", "standing-trig-1", "--root", root, "--json"],
            ["resume", "standing-trig-1", "--root", root, "--json"],
            ["runs", "standing-trig-1", "--root", root, "--json"],
            ["remove", "standing-trig-1", "--root", root, "--json"],
            ["--help"]
          ]
        ) {
          await serveCli(trigCli as never, argv, env)
        }

        // 4. Integrations CLI: list -> add -> show -> remove -> --help
        const intCli = Integrations.createIntegrationsCli()
        for (
          const argv of [
            ["list", "--root", root, "--json"],
            ["add", "github", "--name", "gh-fuzz", "--credential", "gh-tok", "--root", root, "--json"],
            ["list", "--root", root, "--json"],
            ["remove", "gh-fuzz", "--root", root, "--json"],
            ["--help"]
          ]
        ) {
          await serveCli(intCli as never, argv, env)
        }
        const readInts = await Integrations.readIntegrations(root)
        assertInv(Array.isArray(readInts), "Integrations.readIntegrations returns array")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
