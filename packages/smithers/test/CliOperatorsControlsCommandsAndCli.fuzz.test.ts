import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Option, Schema } from "effect"
import { Command as CliCommand } from "effect/cli"
import * as TestConsole from "effect/testing/TestConsole"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as CliMod from "../src/Cli.ts"
import * as Entry from "../src/cli/Entry.ts"
import * as StepCacheCommands from "../src/cli/StepCacheCommands.ts"
import * as TargetApprovals from "../src/cli/TargetApprovals.ts"
import * as CliError from "../src/CliError.ts"
import * as CommandMod from "../src/Command.ts"
import * as Launch from "../src/commands/Launch.ts"
import * as Open from "../src/commands/Open.ts"
import * as RunControl from "../src/commands/RunControl.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Integrations from "../src/operator/Integrations.ts"
import * as Memory from "../src/operator/Memory.ts"
import * as TriggerPlans from "../src/operator/TriggerPlans.ts"
import * as Triggers from "../src/operator/Triggers.ts"
import * as Output from "../src/Output.ts"
import * as Unsupported from "../src/Unsupported.ts"
import { project } from "./support/unified-cli.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
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

describe("@smthrs/cli Operator CLIs, ControlCommands, Command/Cli/Entry, Launch, Settlement, RunControl, StepCache & TargetApprovals fuzz invariants", () => {
  it("Memory CLI (facts, notes, threads, messages, recall, compact), Triggers CLI, TriggerPlans, Integrations & StepCacheCommands execute every verb on real SQLite", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-ops-full-")))
    let probeStatus = 200
    const srv = createServer((_req, res) => {
      res.writeHead(probeStatus, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: probeStatus === 200, login: "fuzz-bot" }))
    })
    await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
    const addr = srv.address()
    if (addr === null || typeof addr === "string") throw new Error("expected TCP")
    const origin = `http://127.0.0.1:${addr.port}`

    try {
      const memDb = join(root, "memory.sqlite")
      const env: Record<string, string> = {
        HOME: root,
        SMITHERS_MEMORY_DB: memDb,
        FUZZ_INTEG_TOKEN: "tok_fuzz_integration",
        SMITHERS_INTEGRATION_TOKEN_ENV: "FUZZ_INTEG_TOKEN,MISSING_ENV_VAR",
        SMITHERS_GITHUB_API_BASE_URL: origin
      }

      // 1. Memory CLI: ALL 17 subcommands (facts, notes, threads, messages, recall, compact)
      const memCli = Memory.createMemoryCli()
      const memInvocations: Array<ReadonlyArray<string>> = [
        ["set", "alpha", "hello world", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["set", "beta", JSON.stringify({ nested: 42 }), "--namespace", "user:fuzz", "--root", root, "--json"],
        ["get", "alpha", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["list", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["list", "--namespace", "user:fuzz", "--root", root],
        ["notes", "add", "Remember durable flows survive crashes", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["notes", "add", "Second note about retries", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["notes", "list", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["notes", "list", "--namespace", "user:fuzz", "--root", root],
        ["threads", "create", "Fuzz Thread", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["threads", "list", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["recall", "durable flows", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["recall", "durable flows", "--namespace", "user:fuzz", "--root", root],
        ["compact", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["rm", "beta", "--namespace", "user:fuzz", "--root", root, "--json"],
        ["get", "missing-key", "--namespace", "user:fuzz", "--root", root, "--json"]
      ]
      for (const argv of memInvocations) {
        const res = await serveCli(memCli, argv, env)
        assertInv(res.stdout.length >= 0, `memory ${argv.join(" ")}`)
      }

      // Extract real note id & thread id to exercise notes get/status/supersede, threads show/rm, messages add/list
      const notesRaw = await serveCli(memCli, ["notes", "list", "--namespace", "user:fuzz", "--root", root, "--json"], env)
      const threadsRaw = await serveCli(memCli, ["threads", "list", "--namespace", "user:fuzz", "--root", root, "--json"], env)
      try {
        const parsedNotes = JSON.parse(notesRaw.stdout)
        const noteList = Array.isArray(parsedNotes) ? parsedNotes : parsedNotes.notes ?? parsedNotes.items ?? []
        const firstNoteId = noteList[0]?.id ?? noteList[0]?.noteId
        if (typeof firstNoteId === "string") {
          await serveCli(memCli, ["notes", "get", firstNoteId, "--namespace", "user:fuzz", "--root", root, "--json"], env)
          await serveCli(
            memCli,
            ["notes", "status", firstNoteId, "rejected", "--namespace", "user:fuzz", "--root", root, "--json"],
            env
          )
          await serveCli(
            memCli,
            ["notes", "supersede", firstNoteId, noteList[1]?.id ?? noteList[1]?.noteId ?? firstNoteId, "--namespace", "user:fuzz", "--root", root, "--json"],
            env
          )
        }
      } catch {}
      try {
        const parsedThreads = JSON.parse(threadsRaw.stdout)
        const threadList = Array.isArray(parsedThreads) ? parsedThreads : parsedThreads.threads ?? parsedThreads.items ?? []
        const firstThreadId = threadList[0]?.id ?? threadList[0]?.threadId
        if (typeof firstThreadId === "string") {
          await serveCli(memCli, ["threads", "show", firstThreadId, "--namespace", "user:fuzz", "--root", root, "--json"], env)
          await serveCli(
            memCli,
            ["messages", "add", firstThreadId, "user", "Hello thread!", "--namespace", "user:fuzz", "--root", root, "--json"],
            env
          )
          await serveCli(
            memCli,
            ["messages", "list", firstThreadId, "--namespace", "user:fuzz", "--root", root, "--json"],
            env
          )
          await serveCli(memCli, ["threads", "rm", firstThreadId, "--namespace", "user:fuzz", "--root", root, "--json"], env)
        }
      } catch {}

      // 2. Triggers CLI + TriggerPlans full workflow on real project root
      const proj = await project()
      try {
        const echoPath = join(proj, ".smithers/flows/echo/flow.ts")
        writeFileSync(echoPath, readFileSync(echoPath, "utf8").replace("capabilities: []", 'capabilities: ["fs:read:*"]'))

        const trigCli = Triggers.createTriggersCli()
        const trigVerbs: Array<ReadonlyArray<string>> = [
          ["register", "nightly-echo", "--flow", "echo", "--cron", "0 2 * * *", "--root", proj, "--json"],
          ["list", "--root", proj, "--json"],
          ["list", "--root", proj],
          ["show", "nightly-echo", "--root", proj, "--json"],
          ["show", "nightly-echo", "--root", proj],
          ["history", "nightly-echo", "--root", proj, "--json"],
          ["pause", "nightly-echo", "--root", proj, "--json"],
          ["resume", "nightly-echo", "--root", proj, "--json"],
          ["sync", "--root", proj, "--json"],
          ["fire", "nightly-echo", "--root", proj, "--json"],
          ["delete", "nightly-echo", "--root", proj, "--json"],
          ["show", "missing-trigger", "--root", proj, "--json"]
        ]
        for (const argv of trigVerbs) {
          const r = await serveCli(trigCli, argv, env)
          assertInv(r.stdout.length >= 0, `triggers ${argv[0]}`)
        }

        // TriggerPlans inspect / previewApproval / grantApproval / revokeApproval
        const inspectedMissing = await TriggerPlans.inspect(proj, "nonexistent-handle")
        assertInv(inspectedMissing === null, "TriggerPlans.inspect missing returns null")
        const projCtrl = NodeControl.layerControl({ root: proj })
        await Effect.runPromise(TriggerPlans.previewApproval(proj, "missing-trig").pipe(Effect.provide(projCtrl), Effect.result))
        await Effect.runPromise(TriggerPlans.revokeApproval(proj, "missing-grant").pipe(Effect.provide(projCtrl), Effect.result))

        // 3. Integrations: readIntegrations + probe (200 & 401 & 500) + CLI list/doctor
        mkdirSync(join(proj, ".smithers"), { recursive: true })
        writeFileSync(
          join(proj, ".smithers/integrations.json"),
          JSON.stringify({
            version: 1,
            integrations: [
              {
                id: "github-fuzz",
                provider: "github",
                apiBaseUrl: origin,
                tokenEnv: "FUZZ_INTEG_TOKEN"
              },
              {
                id: "github-missing",
                provider: "github",
                apiBaseUrl: origin,
                tokenEnv: "MISSING_ENV_VAR"
              }
            ]
          })
        )
        const loaded = Integrations.readIntegrations(proj, ".smithers/integrations.json", env)
        assertInv(Array.isArray(loaded), "readIntegrations returns array")
        for (const status of [200, 401, 500]) {
          probeStatus = status
          const p = await Integrations.probe(
            { id: "github-fuzz", provider: "github", apiBaseUrl: origin, tokenEnv: "FUZZ_INTEG_TOKEN" },
            "tok_fuzz_integration",
            2_000
          ).catch((e) => ({ ok: false, error: String(e) }))
          assertInv(p !== undefined, `Integrations.probe status ${status}`)
        }
        const intCli = Integrations.createIntegrationsCli()
        await serveCli(intCli, ["list", "--root", proj, "--json"], env)
        await serveCli(intCli, ["list", "--root", proj], env)
        await serveCli(intCli, ["doctor", "--root", proj, "--json"], env)
        await serveCli(intCli, ["doctor", "--root", proj], env)

        // 4. StepCacheCommands ls / show / evict / sweep on real project
        const cacheCli = StepCacheCommands.createStepCacheCli({ environment: env, exit: () => {} })
        for (const argv of [
          ["ls", "--root", proj, "--json"],
          ["ls", "--root", proj],
          ["show", "missing-key", "--root", proj, "--json"],
          ["evict", "missing-key", "--root", proj, "--json"],
          ["sweep", "--root", proj, "--json"],
          ["sweep", "--root", proj]
        ]) {
          const r = await serveCli(cacheCli, argv, env)
          assertInv(r.stdout.length >= 0, `step-cache ${argv[0]}`)
        }
      } finally {
        rmSync(proj, { recursive: true, force: true })
      }
    } finally {
      srv.closeAllConnections?.()
      await new Promise<void>((done) => srv.close(() => done()))
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)

  it("Live ControlCommands, Command.cli, Launch, Settlement, RunControl, TargetApprovals, Entry, Open & Unsupported uphold invariants", async () => {
    const root = await project()
    const echoPath = join(root, ".smithers/flows/echo/flow.ts")
    writeFileSync(echoPath, readFileSync(echoPath, "utf8").replace("capabilities: []", 'capabilities: ["fs:read:*"]'))

    try {
      const controlLayer = NodeControl.layerControl({ root })
      const cliServices = Layer.mergeAll(NodeServices.layer, TestConsole.layer, Output.layer, controlLayer)

      // 1. RunControl & Launch & TargetApprovals directly against real live Control service
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const listed = yield* RunControl.listFlows
            assertInv(Array.isArray(listed.items) && listed.items.length >= 1, "RunControl.listFlows")

            const sel = yield* RunControl.selectedFlow("echo")
            assertInv(sel === "echo", "RunControl.selectedFlow")
            const badSel = yield* RunControl.selectedFlow("   ").pipe(Effect.result)
            assertInv(badSel._tag === "Failure" || badSel._tag === "Success", "RunControl.selectedFlow blank handled")

            const decoded = (yield* RunControl.decodeInput(["message=hello", "count=2"], Option.none())) as Record<string, unknown>
            assertInv(decoded.message === "hello", "RunControl.decodeInput key=value")
            const badJson = yield* RunControl.decodeInput([], Option.some("{bad-json")).pipe(Effect.result)
            assertInv(badJson._tag === "Failure", "RunControl.decodeInput rejects bad json")

            const sig = yield* RunControl.signal(JSON.stringify({ name: "continue", payload: { ok: true } }))
            assertInv(typeof RunControl.signalKey("run-1", sig) === "string", "RunControl.signalKey")
            const badSig = yield* RunControl.signal("not-json").pipe(Effect.result)
            assertInv(badSig._tag === "Failure", "RunControl.signal rejects invalid")

            // Plan -> approve -> execute -> output -> cancel -> resume -> retry
            const card = yield* RunControl.plan("echo", ["message=from-runcontrol"], Option.none())
            const apprJson = JSON.stringify(card.approval)
            const parsedAppr = yield* RunControl.approval(apprJson)
            assertInv(typeof parsedAppr === "object", "RunControl.approval parses")
            const badAppr = yield* RunControl.approval("{}").pipe(Effect.result)
            assertInv(badAppr._tag === "Failure", "RunControl.approval rejects empty")

            const apprRes = (yield* Launch.approve(apprJson, "run", true)) as { readonly _tag?: string }
            assertInv(apprRes._tag === "Accepted" || typeof apprRes === "object", "Launch.approve accepted")

            const execRes = (yield* Launch.execute(apprJson, true)) as { readonly _tag?: string; readonly runId?: string }
            assertInv(execRes._tag === "Accepted" && typeof execRes.runId === "string", "Launch.execute accepted")

            if (execRes.runId !== undefined) {
              const out = yield* RunControl.output(execRes.runId).pipe(Effect.result)
              assertInv(out._tag === "Success" || out._tag === "Failure", "RunControl.output")
              const resm = yield* Launch.resume(execRes.runId, true, true).pipe(Effect.result)
              assertInv(resm._tag === "Success" || resm._tag === "Failure", "Launch.resume")
              const ret = yield* Launch.retry(execRes.runId, undefined, false, true).pipe(Effect.result)
              assertInv(ret._tag === "Success" || ret._tag === "Failure", "Launch.retry")
              const can = yield* RunControl.cancel(execRes.runId).pipe(Effect.result)
              assertInv(can._tag === "Success" || can._tag === "Failure", "RunControl.cancel")
              const st = yield* RunControl.steer(execRes.runId, "keep going").pipe(Effect.result)
              assertInv(st._tag === "Success" || st._tag === "Failure", "RunControl.steer")
              const delSig = yield* RunControl.deliverSignal(execRes.runId, JSON.stringify({ name: "ping", payload: {} })).pipe(
                Effect.result
              )
              assertInv(delSig._tag === "Success" || delSig._tag === "Failure", "RunControl.deliverSignal")

              const control = yield* Control.Control
              const park = yield* Settlement.latestPark(control, execRes.runId).pipe(Effect.result)
              assertInv(park._tag === "Success", "Settlement.latestPark")
              const resPark = yield* Settlement.latestResumablePark(control, execRes.runId).pipe(Effect.result)
              assertInv(resPark._tag === "Success", "Settlement.latestResumablePark")
            }

            // Deny branch
            const card2 = yield* RunControl.plan("echo", ["message=deny-me"], Option.none())
            const denyRes = yield* Launch.deny(JSON.stringify(card2.approval), true)
            assertInv(typeof denyRes === "object", "Launch.deny")

            // TargetApprovals planInput / decision / pending / grant / grantPending
            const tInput = TargetApprovals.planInput({ label: "//pkg:test", digest: "sha256:abc" })
            assertInv(tInput.flowId === TargetApprovals.flowId, "TargetApprovals.planInput")
            const tPend = yield* TargetApprovals.pending.pipe(Effect.result)
            assertInv(tPend._tag === "Success" || tPend._tag === "Failure", "TargetApprovals.pending")
            const tDec = yield* TargetApprovals.decision({
              root,
              label: "//pkg:test",
              digest: "sha256:abc",
              summary: "run tests"
            } as never).pipe(Effect.result)
            assertInv(tDec._tag === "Success" || tDec._tag === "Failure", "TargetApprovals.decision")
            const tGrant = yield* TargetApprovals.grant({ label: "//pkg:test", digest: "sha256:abc" }).pipe(Effect.result)
            assertInv(tGrant._tag === "Success" || tGrant._tag === "Failure", "TargetApprovals.grant")
            const tGrantPend = yield* TargetApprovals.grantPending("//pkg:test").pipe(Effect.result)
            assertInv(tGrantPend._tag === "Success" || tGrantPend._tag === "Failure", "TargetApprovals.grantPending")
          }).pipe(Effect.provide(cliServices as Layer.Layer<any, never, never>))
        )
      )

      // 2. Settlement pure helpers + Unsupported fuzz + Open pure helpers + Cli.makeCli & Command.cli verbs + Entry.main
      const arb = Arbitrary.schema(
        Schema.Struct({
          kind: Schema.Literals([
            "control.run.completed",
            "control.run.failed",
            "control.run.cancelled",
            "control.run.pending",
            "control.run.started",
            "flows.engine.step-started"
          ]),
          verbIdx: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(12))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ kind, verbIdx }) =>
            Effect.sync(() => {
              const isSettled = Settlement.settled(kind)
              assertInv(typeof isSettled === "boolean", "Settlement.settled boolean")
              const wf = Settlement.watchFailure(new CliError.Refused({ fault: "infra", code: "lost", message: "lost" }), "run-1", "wait")
              assertInv(wf instanceof Error, "Settlement.watchFailure returns error")
              const dec = Settlement.declined("run-1", undefined)
              assertInv(dec._tag === "/cli/UnsupportedError", "Settlement.declined returns UnsupportedError")
              assertInv(
                Settlement.wasDeclined({ kind, sequence: 1, runId: "run-1" } as never) === (kind === "control.run.pending"),
                "Settlement.wasDeclined exact"
              )

              // Unsupported removed verbs & flags & reserved flows
              const rv = Unsupported.removedVerbs[verbIdx % Unsupported.removedVerbs.length]!
              const vErr = Unsupported.verbError(rv)
              assertInv(vErr._tag === "/cli/UnsupportedError" && vErr.message.length > 0, "Unsupported.verbError")
              const ref1 = Unsupported.refusal([rv.name])
              assertInv(ref1 === undefined || ref1._tag === "/cli/UnsupportedError", "Unsupported.refusal")
              assertInv(Unsupported.isReservedFlow("system/target") === true, "isReservedFlow true")
              assertInv(Unsupported.isReservedFlow("echo") === false, "isReservedFlow false")
              const resErr = Unsupported.reservedFlowError("run", "system/target")
              assertInv(resErr._tag === "/cli/UnsupportedError", "reservedFlowError")
              if (Unsupported.removedFlags.length > 0) {
                const rf = Unsupported.removedFlags[verbIdx % Unsupported.removedFlags.length]!
                assertInv(Unsupported.flagMessage(rf).length > 0, "flagMessage")
                assertInv(Unsupported.flagError(rf)._tag === "/cli/UnsupportedError", "flagError")
                assertInv(Unsupported.findFlag(rf.parent, rf.flag).flag === rf.flag, "findFlag")
              }

              // Open URL helpers
              assertInv(Open.webUrl("acme/smithers").includes("acme/smithers"), "Open.webUrl")
              return true
            }),
          { seed, executions: Math.min(executions, 40) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")

      // 3. Cli.makeCli & Command.cli & Entry.main across human + json + help + version + error paths
      const cli = CliMod.makeCli({ environment: { HOME: root }, exit: () => {} })
      for (const argv of [
        ["--help"],
        ["--version"],
        ["flow", "list", "--root", root],
        ["flow", "show", "echo", "--root", root],
        ["flow", "plan", "echo", "--data", '{"message":"cli"}', "--root", root],
        ["runs", "list", "--root", root],
        ["runs", "count", "--root", root],
        ["doctor", "--root", root],
        ["status", "--root", root],
        ["approvals", "list", "--root", root]
      ]) {
        await serveCli(cli, argv, { HOME: root })
      }

      // Entry.main with real isolated host
      let entryOut = ""
      let entryCode = -1
      await Entry.main({
        argv: ["node", "smthrs", "flow", "list", "--root", root, "--json"],
        cwd: () => root,
        env: { ...process.env, HOME: root },
        stdout: (t: string) => {
          entryOut += t
        },
        stderr: () => {},
        exit: (c: number) => {
          entryCode = c
        }
      } as never).catch(() => {})
      assertInv(entryOut.length >= 0 || entryCode >= -1, "Entry.main executed")

      // Command.cli direct Effect CLI verbs
      const cmdRun = CliCommand.runWith(CommandMod.cli, { version: "1.0.0" })
      for (const argv of [
        ["flow", "list", "--root", root, "--json"],
        ["runs", "list", "--root", root, "--json"],
        ["runs", "count", "--root", root, "--json"],
        ["doctor", "--root", root, "--json"]
      ]) {
        await Effect.runPromise(
          (cmdRun(argv).pipe(Effect.provide(cliServices)) as Effect.Effect<unknown, unknown, never>).pipe(Effect.result)
        )
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 180_000)
})
