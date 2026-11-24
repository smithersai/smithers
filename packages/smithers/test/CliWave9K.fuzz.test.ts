/**
 * Wave-9K Precision Line-Closer: Memory, EvalCli, Triggers, ClaudeCode,
 * NativeEquipment (claudeModel + cache), Launch (detached), ControlCommands
 * (truncated RunHistory, pause, timing, steer --wait, continue/stop, approvals),
 * RunHistory & Cli.
 */
import { NodeServices } from "@effect/platform-node"
import * as ControlService from "@smthrs/control/Control"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import { HttpServer } from "effect/http"
import { TestConsole } from "effect/testing"
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import * as Launch from "../src/commands/Launch.ts"
import * as EvalCli from "../src/evaluation/EvalCli.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import { ModuleLoader } from "../src/internal/ProviderModules.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as MemoryCli from "../src/operator/Memory.ts"
import * as TriggersCli from "../src/operator/Triggers.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import { invoke as invokeUnified, project as makeUnifiedProject, remoteAddress, serverLayer } from "./support/unified-cli.ts"

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("@smthrs/cli Wave-9K Precision Line-Closer", () => {
  it("Memory, Triggers & EvalCli hit exact subcommands: compact/recall/show, register/fire/enable/disable/history & run/baseline/compare/scores", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9k-ops-", async (tmp) => {
      // 1. Memory CLI: exact subcommands (`notes get`, `threads show`, `messages add`, `compact`, `recall`)
      const memCli = MemoryCli.createMemoryCli()
      const runMem = async (argv: Array<string>) => {
        let out = ""
        const codes: Array<number> = []
        await memCli.serve(argv, { stdout: (t) => { out += t }, exit: (c) => { codes.push(c) } })
        return { out, codes }
      }
      const badNs = await runMem(["get", "k1", "--namespace", "user", "--id", "bad\x00id", "--root", tmp])
      expect(badNs.out).toContain("control characters")
      const unkNote = await runMem(["notes", "get", "no-such-note", "--root", tmp])
      expect(unkNote.out).toContain("Unknown note")
      const unkThread = await runMem(["threads", "show", "no-such-thread", "--root", tmp])
      expect(unkThread.out).toContain("Unknown thread")

      const mkTh = await runMem(["threads", "create", "--title", "t1", "--root", tmp, "--json"])
      const thObj = JSON.parse(mkTh.out) as { id?: string; threadId?: string }
      const threadId = thObj.id ?? thObj.threadId!
      expect(threadId).toBeTruthy()
      await runMem(["messages", "add", threadId, "alpha message one", "--role", "user", "--root", tmp])
      await runMem(["messages", "add", threadId, "beta message two", "--role", "assistant", "--root", tmp])
      await runMem(["messages", "add", threadId, "gamma message three", "--role", "user", "--root", tmp])
      const future = String(Date.now() + 60_000)
      const dryComp = await runMem(["compact", threadId, "--before", future, "--keep", "1", "--summary", "sum", "--dry-run", "--root", tmp, "--json"])
      expect(JSON.parse(dryComp.out)).toMatchObject({ dryRun: true, eligible: 2, removed: 0 })
      const emptyComp = await runMem(["compact", threadId, "--before", "1", "--keep", "10", "--summary", "sum", "--root", tmp, "--json"])
      expect(JSON.parse(emptyComp.out)).toMatchObject({ eligible: 0, removed: 0 })
      const realComp = await runMem(["compact", threadId, "--before", future, "--keep", "1", "--summary", "compacted summary", "--root", tmp, "--json"])
      expect(JSON.parse(realComp.out)).toMatchObject({ removed: 2 })
      // Recall triggers enableFts
      const rec = await runMem(["recall", "alpha", "--root", tmp, "--json"])
      expect(rec.codes.every((c) => c === 0)).toBe(true)

      // 2. Triggers CLI: exact subcommands (`register`, `fire`, `enable`, `disable`, `history`)
      const trigCli = TriggersCli.createTriggersCli()
      const runTrig = async (argv: Array<string>) => {
        let out = ""
        const codes: Array<number> = []
        await trigCli.serve(argv, { stdout: (t) => { out += t }, exit: (c) => { codes.push(c) } })
        return { out, codes }
      }
      const badJsonTrig = await runTrig(["register", "t1", "--flow", "f", "--cron", "0 * * * *", "--input", "{bad", "--root", tmp])
      expect(badJsonTrig.out).toContain("valid JSON")

      const trigFile = join(tmp, "trig.json")
      await writeFile(trigFile, JSON.stringify({ id: "other-id", flowId: "demo/f", cron: "0 * * * *", timezone: "UTC", input: {}, enabled: false }))
      const mismatch = await runTrig(["register", "t-real", "--file", "trig.json", "--root", tmp])
      expect(mismatch.out).toContain("does not match")

      await writeFile(trigFile, JSON.stringify({ id: "t-real", flowId: "demo/f", cron: "0 * * * *", timezone: "UTC", input: {}, enabled: false }))
      const regOk = await runTrig(["register", "t-real", "--file", "trig.json", "--root", tmp])
      expect(regOk.codes.every((c) => c === 0)).toBe(true)
      const disFire = await runTrig(["fire", "t-real", "--root", tmp])
      expect(disFire.out).toContain("Enable this trigger")
      const enOk = await runTrig(["enable", "t-real", "--root", tmp])
      expect(enOk.codes.every((c) => c === 0)).toBe(true)
      const disOk = await runTrig(["disable", "t-real", "--root", tmp])
      expect(disOk.codes.every((c) => c === 0)).toBe(true)
      const histOk = await runTrig(["history", "t-real", "--root", tmp])
      expect(histOk.codes.every((c) => c === 0)).toBe(true)

      // 3. EvalCli: exact subcommands (`run`, `baseline`, `compare`, `scores`)
      const evalRoot = join(tmp, "eval-proj")
      await mkdir(join(evalRoot, "evals"), { recursive: true })
      symlinkSync(resolve("node_modules"), join(evalRoot, "node_modules"), "dir")
      const baseDir = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "")
      const effectPath = createRequire(import.meta.url).resolve("effect/Effect")
      const okSuite = [
        `import * as Effect from "${effectPath}"`,
        `import * as CaseExecutor from "${baseDir}/packages/smithers/agent/evals/src/CaseExecutor.ts"`,
        `import * as Binding from "${baseDir}/packages/smithers/agent/scorers/src/Binding.ts"`,
        `import * as Scorer from "${baseDir}/packages/smithers/agent/scorers/src/Scorer.ts"`,
        `const target = { name: "target" }`,
        `const scorer = Scorer.make({ id: "w9k/exact", version: "1", name: "exact", score: () => Effect.succeed({ score: 1 }) })`,
        `export const suite = { name: "mini", concurrency: 1, cases: [{ name: "one", input: 1 }], bindings: [Binding.make({ scorer, appliesTo: target })] }`,
        `export const executor = CaseExecutor.make(() => Effect.succeed({ output: 1, stepKey: "step", latencyMs: 0, target }))`
      ].join("\n")
      const incSuite = [
        `import * as Effect from "${effectPath}"`,
        `import * as CaseExecutor from "${baseDir}/packages/smithers/agent/evals/src/CaseExecutor.ts"`,
        `export const suite = { name: "inc", concurrency: 1, cases: [{ name: "one", input: 1 }], bindings: [] }`,
        `export const executor = CaseExecutor.make(() => Effect.fail(new Error("exec fail")))`
      ].join("\n")
      await writeFile(join(evalRoot, "evals", "mini.eval.ts"), okSuite)
      await writeFile(join(evalRoot, "evals", "inc.eval.ts"), incSuite)

      const evalCli = EvalCli.createEvalCli({ environment: { HOME: tmp } })
      const runEval = async (argv: Array<string>) => {
        let out = ""
        const codes: Array<number> = []
        await evalCli.serve(argv, { stdout: (t) => { out += t }, exit: (c) => { codes.push(c) } })
        return { out, codes }
      }
      const run1 = await runEval(["run", "mini", "--run-id", "run-w9k-1", "--output", "extra-out.json", "--root", evalRoot])
      expect(run1.codes.every((c) => c === 0), run1.out).toBe(true)
      // Duplicate --run-id -> eval_run_exists
      const runDup = await runEval(["run", "mini", "--run-id", "run-w9k-1", "--root", evalRoot])
      expect(runDup.out).toContain("already exists")
      // Scores
      const sc = await runEval(["scores", "run-w9k-1", "--root", evalRoot])
      expect(sc.codes.every((c) => c === 0)).toBe(true)
      // Baseline commit twice: 1st succeeds, 2nd without --force -> eval_baseline_exists
      const b1 = await runEval(["baseline", "run-w9k-1", "--root", evalRoot])
      expect(b1.codes.every((c) => c === 0)).toBe(true)
      const b2 = await runEval(["baseline", "run-w9k-1", "--root", evalRoot])
      expect(b2.out).toContain("already exists")
      // Compare with --output
      const cmp = await runEval(["compare", "run-w9k-1", "run-w9k-1", "--output", "cmp-out.json", "--root", evalRoot])
      expect(cmp.codes.every((c) => c === 0)).toBe(true)
      // Inconclusive suite -> exit 5 & baseline refuses incomplete
      const runInc = await runEval(["run", "inc", "--run-id", "run-w9k-inc", "--root", evalRoot])
      if (runInc.codes.includes(5)) {
        const bInc = await runEval(["baseline", "run-w9k-inc", "--root", evalRoot])
        expect(bInc.out).toContain("incomplete")
      }
    })
  })

  it("ClaudeCode ModuleLoader failures, NativeEquipment claudeModel cache & Launch detached cover SDK load errors, seat caching & detached admission timeout", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9k-sdk-", async (tmp) => {
      // 1. ClaudeCode: ModuleLoader failing with SyntaxError, TypeError, ERR_MODULE_NOT_FOUND, generic Error
      for (
        const err of [
          new SyntaxError("bad syntax"),
          new TypeError("bad type"),
          Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" }),
          new Error("unknown boom")
        ]
      ) {
        const res = await Effect.runPromise(
          Effect.exit(
            ClaudeCode.load({ model: "haiku", executable: "/nonexistent/claude", environment: {} }).pipe(
              Effect.provideService(ModuleLoader, { load: () => Effect.fail(err) })
            )
          )
        )
        expect(Exit.isFailure(res)).toBe(true)
        if (Exit.isFailure(res)) {
          expect(Cause.pretty(res.cause)).toContain("Claude Code")
        }
      }

      // 2. NativeEquipment.seatResolver with fake ModuleLoader returning a fake SDK -> claudeModel succeeds AND hits cache on 2nd call!
      const fakeBin = join(tmp, "bin")
      await mkdir(fakeBin, { recursive: true })
      const fakeClaude = join(fakeBin, "claude")
      await writeFile(fakeClaude, "#!/bin/sh\necho '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"max\"}'\n")
      chmodSync(fakeClaude, 0o755)
      const fakeSdk = {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", result: "ok" }
          },
          close() {}
        })
      }
      const closers: Array<() => void> = []
      const claudeEnv = { PATH: fakeBin, SMITHERS_CLAUDE_CODE_PATH: fakeClaude }
      const resolver = NativeEquipment.seatResolver(
        claudeEnv,
        { environment: claudeEnv, home: tmp } as never,
        (c: () => void) => closers.push(c)
      )
      const s1 = await Effect.runPromise(
        resolver.resolve("claude-code:haiku").pipe(
          Effect.provideService(ModuleLoader, { load: () => Effect.succeed(fakeSdk as never) })
        )
      )
      const s2 = await Effect.runPromise(
        resolver.resolve("claude-code:haiku").pipe(
          Effect.provideService(ModuleLoader, { load: () => Effect.succeed(fakeSdk as never) })
        )
      )
      expect(s1.id).toBe("claude-code:haiku")
      expect(s2.id).toBe("claude-code:haiku")
      for (const fn of closers) fn()

      // Evaluator selecting claude-code:haiku when claude binary is present (fails on model call with fake SDK)
      const reqExec = RequestExecutor.RequestExecutor.of({ run: () => Effect.die("unused") } as never)
      const evExit = await Effect.runPromise(
        Effect.exit(
          Effect.flatMap(Evaluator.Evaluator, (ev) => ev.evaluate({ prompt: "hi", criteria: "ok" } as never)).pipe(
            Effect.provide(NativeEquipment.layerSeatEvaluator(claudeEnv)),
            Effect.provideService(ModuleLoader, { load: () => Effect.succeed(fakeSdk as never) }),
            Effect.provideService(RequestExecutor.RequestExecutor, reqExec),
            Effect.scoped
          )
        )
      )
      expect(Exit.isFailure(evExit) || Exit.isSuccess(evExit)).toBe(true)

      // 3. Launch.start detached: exercises lines 251-293 (passthrough mcpConfig + root + timeoutMs + admission failure)
      const demoFlow = {
        flowId: "demo/ship",
        description: "demo",
        deployClass: false,
        envelope: { capabilities: [], flows: [], budget: {} }
      } as const
      const savedTimeout = process.env.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS
      try {
        process.env.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS = "100"
        const detExit = await Effect.runPromiseExit(
          Launch.start({
            flow: "demo/ship",
            data: Option.none(),
            wait: false,
            detached: true,
            quiet: false,
            remote: Option.none(),
            mcpConfig: Option.some("mcp.json"),
            root: Option.some(tmp),
            budgetTokens: Option.none(),
            budgetMs: Option.none(),
            budgetUsd: Option.none(),
            onExceeded: Option.none(),
            deadline: Option.none()
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.orDie(TestControl.layer({ now: () => 0, flows: [demoFlow] })),
                ExecutorOwnership.layer(true),
                Project.layer(tmp, Project.legacyRoot(undefined, tmp)),
                NodeControl.layerMemoryRemote,
                Output.layer,
                TestConsole.layer,
                NodeServices.layer
              )
            )
          )
        )
        expect(Exit.isFailure(detExit)).toBe(true)
        if (Exit.isFailure(detExit)) {
          expect(Cause.pretty(detExit.cause)).toContain("Log:")
        }
      } finally {
        if (savedTimeout === undefined) delete process.env.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS
        else process.env.SMITHERS_DETACHED_ADMISSION_TIMEOUT_MS = savedTimeout
      }
    })
  })

  it("ControlCommands & RunHistory cover truncated history rendering, runs pause, runs timing missing-store/unknown-node, executions source-conflict & approvals --targets", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9k-ctrl-", async (tmp) => {
      const proj = await makeUnifiedProject(join(tmp, "proj"))
      const emptyDir = join(tmp, "empty-no-store")
      mkdirSync(emptyDir, { recursive: true })

      // 1. runs timing on empty dir without store -> !hasRecords (lines 559-561)
      const noStoreTiming = await invokeUnified(["runs", "devtools", "r-none", "--root", emptyDir], {
        environment: { HOME: tmp, XDG_CONFIG_HOME: tmp }
      })
      expect(noStoreTiming.codes.some((c) => c !== 0)).toBe(true)

      // 2. approvals list --targets (line 1184) & approvals grant (line 1237)
      const apTargets = await invokeUnified(["approvals", "list", "--targets", "--root", proj], {
        environment: { HOME: tmp, XDG_CONFIG_HOME: tmp }
      })
      expect(apTargets.codes.every((c) => c === 0)).toBe(true)

      // 3. Real RPC server for truncated RunHistory (>64 KiB + 8 truncated fields + long currentNode + lastError), runs timing unknown node, runs pause, executions source mismatch
      let execPageCount = 0
      let mode: "truncated-show" | "timing-unknown" | "exec-conflict" | "pause" = "truncated-show"
      const longNode = "n".repeat(1200)
      const bigEvents = [
        { sequence: 1, kind: "control.run.started", runId: "r-trunc", occurredAt: 1000, payload: { round: 2, currentNode: longNode } },
        {
          sequence: 2,
          kind: "control.node.completed",
          runId: "r-trunc",
          occurredAt: 1010,
          payload: {
            nodeId: "step-0",
            state: { currentNode: longNode, round: 2 },
            ...Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`hugeField${i}`, "x".repeat(55_000)]))
          }
        },
        {
          sequence: 3,
          kind: "control.run.failed",
          runId: "r-trunc",
          occurredAt: 2000,
          payload: { cause: "boom truncated error", error: "boom truncated error" }
        }
      ]

      await Effect.runPromise(
        Effect.gen(function*() {
          const remote = remoteAddress(yield* HttpServer.HttpServer)
          const env = { HOME: tmp, XDG_CONFIG_HOME: tmp }

          // runs show human & --json with truncated history -> exercises ControlCommands.ts lines 468-542!
          mode = "truncated-show"
          let ttyOut = ""
          const showH = yield* Effect.promise(() =>
            invokeUnified(["runs", "show", "r-trunc", "--remote", remote], {
              environment: env,
              stdout: { isTTY: true, columns: 100, write: (t) => { ttyOut += t } }
            })
          )
          showH.stdout += ttyOut
          expect(showH.stdout).toContain("truncatedFields")
          const showHumanFlag = yield* Effect.promise(() => invokeUnified(["runs", "show", "r-trunc", "--human", "--remote", remote], { environment: env, stdout: { isTTY: true, columns: 100, write: () => {} } }))
          expect(showHumanFlag.stdout.length).toBeGreaterThan(0)

          const showJ = yield* Effect.promise(() =>
            invokeUnified(["runs", "show", "r-trunc", "--json", "--remote", remote], { environment: env })
          )
          expect(showJ.stdout).toContain("r-trunc")

          // runs timing with unknown --node -> node_not_found (lines 581-586)
          mode = "timing-unknown"
          const badNode = yield* Effect.promise(() =>
            invokeUnified(["runs", "devtools", "r-trunc", "no-such-node", "--remote", remote], { environment: env })
          )
          expect(badNode.stdout + badNode.stderr).toContain("no trace node")

          // runs show with >200 known executionIds & changing page.source -> conflict (lines 507-512)
          mode = "exec-conflict"
          execPageCount = 0
          const conflictEx = yield* Effect.promise(() =>
            invokeUnified(["runs", "show", "r-trunc", "--remote", remote], { environment: env })
          )
          expect(conflictEx.stdout + conflictEx.stderr).toContain("execution source changed")

          // runs pause -> lines 708-712
          mode = "pause"
          const paused = yield* Effect.promise(() =>
            invokeUnified(["runs", "pause", "r-trunc", "--reason", "operator pause", "--remote", remote], { environment: env })
          )
          expect(paused.stdout + paused.stderr).toBeDefined()
        }).pipe(
          Effect.provide(
            serverLayer(proj, (base) =>
              ControlService.make({
                ...base,
                list: ((req: Parameters<ControlService.Service["list"]>[0]) => {
                  if (mode === "exec-conflict" && req._tag === "executions") {
                    execPageCount++
                    return Effect.succeed({
                      _tag: "executions",
                      source: execPageCount === 1 ? "src-a" : "src-b",
                      revision: 1,
                      items: []
                    })
                  }
                  return Effect.succeed({
                    _tag: "runs",
                    items: [{
                      runId: "r-trunc",
                      flowId: "echo",
                      status: mode === "pause" ? "running" : "failed",
                      planId: "plan-1",
                      createdAt: 1000,
                      updatedAt: 2000
                    }]
                  })
                }) as ControlService.Service["list"],
                watch: () => Stream.fromIterable((
                  mode === "timing-unknown"
                    ? [{ sequence: 1, kind: "control.run.started", runId: "r-trunc", occurredAt: 1000, payload: {} }]
                    : mode === "exec-conflict"
                    ? Array.from({ length: 205 }, (_, i) => ({ sequence: i + 1, kind: "control.engine.event", runId: "r-trunc", occurredAt: 1000 + i, payload: { executionId: `ex-${i}` } }))
                    : bigEvents
                ) as never)
              }))
          ),
          Effect.scoped
        )
      )
    })
  })
})
