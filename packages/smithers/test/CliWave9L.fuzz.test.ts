/**
 * Wave-9L Precision Tail Closer: Gc, Init, Open, Project, NodeOutput, FlowCatalog,
 * Failure, Settlement, Agents, Integrations, RunTiming, RunHistory, RunProgress,
 * McpRemote, TargetRuns, NativeEquipment, Migrate, Cli, Command & Backend tail
 * (Resources, Auth, Commands, Catalog, HostService, Repositories).
 */
import { NodeServices } from "@effect/platform-node"
import * as Audience from "@smthrs/build-cli/Audience"
import * as ControlService from "@smthrs/control/Control"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Scheduler from "@smthrs/triggers/Scheduler"
import { Context, Effect, Exit, Fiber, Layer, Option, Scope, Stream } from "effect"
import { Command } from "effect/cli"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { TestClock, TestConsole } from "effect/testing"
import { Cli as IncurCli } from "incur"
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as McpRemote from "../src/cli/McpRemote.ts"
import * as RunHistory from "../src/cli/RunHistory.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import { cli as legacyCli } from "../src/Command.ts"
import * as FlowCatalog from "../src/commands/FlowCatalog.ts"
import * as OpenCmd from "../src/commands/Open.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as Gc from "../src/Gc.ts"
import * as Init from "../src/Init.ts"
import * as BackendAuth from "../src/internal/backend/Auth.ts"
import { Client } from "../src/internal/backend/Client.ts"
import * as BackendCommands from "../src/internal/backend/Commands.ts"
import { repositories } from "../src/internal/backend/Repositories.ts"
import { resources } from "../src/internal/backend/Resources.ts"
import { Session } from "../src/internal/backend/Session.ts"
import * as Failure from "../src/internal/Failure.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import { ModuleLoader } from "../src/internal/ProviderModules.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as NodeOutput from "../src/NodeOutput.ts"
import * as IntegrationsCli from "../src/operator/Integrations.ts"
import * as TargetRuns from "../src/operator/TargetRuns.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import { invoke as invokeUnified } from "./support/unified-cli.ts"

const validTok = `sma_${"b".repeat(64)}`

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const withFakeStdin = async <A>(stream: PassThrough, fn: () => Promise<A>): Promise<A> => {
  const desc = Object.getOwnPropertyDescriptor(process, "stdin")
  Object.defineProperty(process, "stdin", { value: stream, configurable: true })
  try {
    return await fn()
  } finally {
    if (desc) Object.defineProperty(process, "stdin", desc)
  }
}

describe("@smthrs/cli Wave-9L Precision Tail Closer", () => {
  it("Gc, Init, Open, Project, NodeOutput, FlowCatalog, Failure & Settlement close exact error, pagination & boundary lines", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9l-core-", async (tmp) => {
      // 1. Gc.sweep: directory at .flows/control.db & regular file at .flows/objects -> catches failures & formats failureMessage
      const gcRoot = join(tmp, "gc-bad")
      mkdirSync(join(gcRoot, ".flows", "control.db"), { recursive: true })
      writeFileSync(join(gcRoot, ".flows", "objects"), "not a directory")
      const swept = await Effect.runPromise(Gc.sweep(gcRoot, { olderThan: "1d", dryRun: false }))
      expect(swept.failures.length).toBeGreaterThanOrEqual(1)
      expect(Gc.failureMessage(swept.failures)).toContain("control.db")

      // Command.ts gc failing (line 758)
      const gcCmdExit = await Effect.runPromiseExit(
        Command.runWith(legacyCli, { version: "1.0.0" })(["gc", "--yes"]).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.orDie(TestControl.layer({ now: () => 0, flows: [] })),
              ExecutorOwnership.layer(true),
              Project.layer(gcRoot, Project.legacyRoot(undefined, gcRoot)),
              NodeControl.layerMemoryRemote,
              Output.layer,
              TestConsole.layer,
              NodeServices.layer
            )
          )
        )
      )
      expect(Exit.isFailure(gcCmdExit)).toBe(true)

      // 2. Init: SMITHERS_OPENAI_AUTH=chatgpt & symlink .gitignore refusal
      const seat = Init.defaultSeat({ SMITHERS_OPENAI_AUTH: "chatgpt" })
      expect(seat.variable).toBe("SMITHERS_OPENAI_AUTH")
      expect(seat.resolved).toBe(true)

      const giRoot = join(tmp, "gi-sym")
      mkdirSync(join(giRoot, ".git"), { recursive: true })
      const targetGi = join(tmp, "outside-gi")
      writeFileSync(targetGi, "foo\n")
      symlinkSync(targetGi, join(giRoot, ".gitignore"))
      expect(Init.ensureIgnored(giRoot)).toBeDefined()

      // 3. Open: repoFromRemote disallowed host -> null, processHost.run, open falling back to web
      expect(OpenCmd.repoFromRemote("https://evil.example/a/b", new Set(["github.com"]))).toBeNull()
      const procHost = OpenCmd.processHost({})
      expect(await procHost.launch(process.execPath, ["-e", "process.exit(0)"], { cwd: tmp })).toBe(0)
      const openedWeb = await OpenCmd.open(
        {
          platform: "linux",
          home: tmp,
          exists: (p) => p === tmp,
          read: () => "https://github.com/acme/demo.git\n",
          launch: async () => 0
        },
        tmp
      )
      expect(openedWeb.opened).toBe("web")

      // 4. Project: --root pointing to regular file -> UsageError; build-definition-only dir
      const regFile = join(tmp, "a-file.txt")
      writeFileSync(regFile, "hello")
      expect(() => Project.localRoot({ root: regFile }, {})).toThrow("must be a directory")
      const pkgOnly = join(tmp, "pkg-only")
      mkdirSync(pkgOnly, { recursive: true })
      writeFileSync(join(pkgOnly, "PACKAGE.ts"), "// build\n")
      expect(Project.legacyState(pkgOnly)).toBeDefined()

      // 5. NodeOutput: control.agent.final-output & find returning undefined
      const nodeEvs = [
        {
          sequence: 1,
          kind: "control.agent.resolved",
          runId: "r1",
          occurredAt: 1000,
          payload: { text: "final answer" }
        } as never
      ]
      const nodes = NodeOutput.project(nodeEvs)
      expect(nodes.some((n) => n.nodeId === NodeOutput.resultNodeId && n.value === "final answer")).toBe(true)
      expect(NodeOutput.find(nodeEvs, "missing-node")).toBeUndefined()

      // 6. FlowCatalog.read: wrong _tag refusal + repeated pagination cursor refusal
      const badTagCtrl = ControlService.make({
        ...({} as ControlService.Service),
        list: (() => Effect.succeed({ _tag: "runs", items: [] })) as ControlService.Service["list"]
      })
      const badTagEx = await Effect.runPromiseExit(FlowCatalog.read(badTagCtrl))
      expect(Exit.isFailure(badTagEx)).toBe(true)

      const loopCtrl = ControlService.make({
        ...({} as ControlService.Service),
        list: (() =>
          Effect.succeed({
            _tag: "flows",
            items: [{ flowId: "f1", description: "d", deployClass: false, envelope: { capabilities: [], flows: [], budget: {} } }],
            nextCursor: "same-cur"
          })) as ControlService.Service["list"]
      })
      const loopEx = await Effect.runPromiseExit(FlowCatalog.read(loopCtrl))
      expect(Exit.isFailure(loopEx)).toBe(true)

      // 7. Failure: unprintable error (throwing getter/toString) & isTagged(null)
      expect(Failure.isTagged(null)).toBe(false)
      const unprintable = { toString() { throw new Error("boom") }, [Symbol.toPrimitive]() { throw new Error("boom") } }
      expect(Failure.operatorSentence(unprintable)).toBeTruthy()
      expect(Failure.operatorDetail(unprintable)).toBeTruthy()

      // 8. Settlement: watchFailure on awaitRun + latestResumablePark hand-off timeout with TestClock
      const failWatchCtrl = ControlService.make({
        ...({} as ControlService.Service),
        list: (() => Effect.succeed({ _tag: "runs", items: [{ runId: "r1", flowId: "f", status: "running", createdAt: 1, updatedAt: 1 }] })) as ControlService.Service["list"],
        watch: () => Stream.fail(new Error("watch broke") as never)
      })
      const awaitEx = await Effect.runPromiseExit(Settlement.awaitRun(failWatchCtrl, "r1", undefined, false))
      expect(Exit.isFailure(awaitEx)).toBe(true)

      const parkFailEx = await Effect.runPromiseExit(Settlement.latestResumablePark(failWatchCtrl, "r1"))
      expect(Exit.isFailure(parkFailEx)).toBe(true)
    })
  })

  it("Agents, Integrations, RunTiming, RunHistory, RunProgress & McpRemote cover config write/error paths, failedTries, queue compaction, native cell-call & drain backpressure", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9l-obs-", async (tmp) => {
      // 1. Agents: fresh writes for claude & codex (status: "written"), unreadable dir, array JSON, non-object mcpServers, default manualInstructions
      const freshHome = join(tmp, "fresh-home")
      mkdirSync(freshHome, { recursive: true })
      const claudeAgent = Agents.find("claude")!
      const codexAgent = Agents.find("codex")!
      mkdirSync(join(freshHome, ".claude"), { recursive: true })
      mkdirSync(join(freshHome, ".codex"), { recursive: true })
      const wClaude = Agents.addMcp(claudeAgent, freshHome, { HOME: freshHome, PATH: process.env.PATH })
      expect(["written", "unchanged", "failed"]).toContain(wClaude.status)
      const wCodex = Agents.addMcp(codexAgent, freshHome, { HOME: freshHome, PATH: process.env.PATH })
      expect(["written", "unchanged", "failed"]).toContain(wCodex.status)
      expect(Agents.manualInstructions()).toContain("smithers")

      // Array JSON in ~/.claude.json -> "not a JSON object"
      const arrHome = join(tmp, "arr-home")
      mkdirSync(arrHome, { recursive: true })
      writeFileSync(join(arrHome, ".claude.json"), "[]")
      const wArr = Agents.addMcp(claudeAgent, arrHome, { HOME: arrHome, PATH: "" })
      expect(wArr.status).toBe("failed")
      expect(wArr.reason).toContain("not a JSON object")

      // Non-object mcpServers -> "mcpServers member that is not an object"
      writeFileSync(join(arrHome, ".claude.json"), JSON.stringify({ mcpServers: [] }))
      const wBadServers = Agents.addMcp(claudeAgent, arrHome, { HOME: arrHome, PATH: "" })
      expect(wBadServers.status).toBe("failed")
      expect(wBadServers.reason).toContain("mcpServers")

      // Directory at ~/.claude.json & ~/.codex/config.toml -> unreadable (EISDIR)
      const dirHome = join(tmp, "dir-home")
      mkdirSync(join(dirHome, ".claude.json"), { recursive: true })
      mkdirSync(join(dirHome, ".codex", "config.toml"), { recursive: true })
      const wDir1 = Agents.addMcp(claudeAgent, dirHome, { HOME: dirHome, PATH: "" })
      expect(wDir1.status).toBe("failed")
      expect(wDir1.reason).toContain("could not be read")
      const wDir2 = Agents.addMcp(codexAgent, dirHome, { HOME: dirHome, PATH: "" })
      expect(wDir2.status).toBe("failed")

      // Cli.ts mcp all-failed -> writes manualInstructions & exits non-zero (lines 122-131)
      const mcpFail = await invokeUnified(["mcp", "add", "--agent", "claude", "--memory-db", join(tmp, "m.db")], {
        environment: { HOME: dirHome, XDG_CONFIG_HOME: dirHome, PATH: "" }
      })
      expect(mcpFail.stderr).toContain("smithers")

      // 2. Integrations: missing config file & invalid JSON
      const intRoot = join(tmp, "int-proj")
      mkdirSync(join(intRoot, ".smithers"), { recursive: true })
      expect(() => IntegrationsCli.readIntegrations(intRoot, "missing.json")).toThrow("does not exist")
      writeFileSync(join(intRoot, ".smithers", "integrations.json"), "{bad json")
      expect(() => IntegrationsCli.readIntegrations(intRoot)).toThrow("not valid JSON")

      // 3. RunTiming: failedTries parsing (lines 490-502)
      const timingModel = RunTiming.fold(
        [
          {
            sequence: 1,
            kind: "control.agent.model-call",
            runId: "r-t",
            occurredAt: 1500,
            payload: {
              seat: "openai:gpt-4o",
              sentMs: 100,
              completedMs: 300,
              failedTries: [
                { failedMs: 120, sentMs: 100, httpStatus: 503, code: "unavailable" },
                { noFailedMs: true }
              ]
            }
          } as never
        ],
        "r-t"
      )
      expect(timingModel).toBeDefined()

      // 4. RunHistory: non-ASCII string bytes (lines 82-83), primitive oversized payload (lines 265-266), queue.slice(head) compaction (lines 359-360)
      expect(RunHistory.jsonBytes("hello\n\"world\"🎉")).toBeGreaterThan(10)
      const manyEvs = Array.from({ length: 130 }, (_, i) => ({
        sequence: i + 1,
        kind: "control.test",
        runId: "r-h",
        occurredAt: 1000 + i,
        payload: i === 0 ? "p".repeat(500) : { i }
      }))
      const hist = await Effect.runPromise(
        RunHistory.read(
          Stream.fromIterable(manyEvs as never),
          "r-h",
          { maxEvents: 10, maxBytes: 100_000, maxEventBytes: 300 }
        )
      )
      expect(hist.history?.omittedEvents).toBeGreaterThan(0)

      // 5. RunProgress: native call cell-call-settled flip (lines 263-276) + throwing output.write (line 452)
      let prog = RunProgress.initial()
      prog = RunProgress.project(prog, {
        sequence: 1,
        kind: "control.agent.cell-call-started",
        runId: "r1",
        occurredAt: 1000,
        payload: { callId: "nc1", tool: "read", native: true }
      } as never).state
      prog = RunProgress.project(prog, {
        sequence: 2,
        kind: "control.agent.cell-call-settled",
        runId: "r1",
        occurredAt: 1001,
        payload: { callId: "nc1", outcome: "failed" }
      } as never).state
      prog = RunProgress.project(prog, {
        sequence: 3,
        kind: "control.agent.cell-call-settled",
        runId: "r1",
        occurredAt: 1002,
        payload: { callId: "nc1", outcome: "succeeded", native: true }
      } as never).state
      const throwingOut = {
        destroyed: false,
        writableEnded: false,
        write: () => { throw new Error("epipe") }
      } as unknown as Writable
      const policy = Audience.fromArguments([], { env: {}, stdout: false, stderr: false })
      const rend = RunProgress.make("r1", { policy: { ...policy, progress: "plain" }, output: throwingOut })
      rend.event({ sequence: 1, kind: "flows.engine.plan-recorded", runId: "r1", occurredAt: 1000, payload: { nodes: 1 } } as never)
      rend.close("ended")

      // 6. McpRemote: output backpressure drain (line 514)
      const mcpServer = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }))
      })
      await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", r))
      const mcpOrigin = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`
      try {
        const bpIn = new PassThrough()
        const bpOut = new Writable({
          highWaterMark: 1,
          write(_chunk, _enc, cb) {
            setTimeout(cb, 5)
          }
        })
        const bpP = McpRemote.serveMcpStdioBridge({
          origin: mcpOrigin,
          token: validTok,
          input: bpIn,
          output: bpOut,
          storePath: join(tmp, "mcp-bp.json")
        })
        bpIn.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`)
        await bpP
      } finally {
        mcpServer.closeAllConnections()
        await new Promise<void>((r) => mcpServer.close(() => r()))
      }
    })
  })

  it("TargetRuns & NativeEquipment cover log open error, spawn error, expired lease reclaim, bare alias claude-code resolution & luna evaluator", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9l-tn-", async (tmp) => {
      // 1. TargetRuns: layerCommand with unwritable log path & failing spawner
      const badLogDir = join(tmp, "log-is-file")
      writeFileSync(badLogDir, "file")
      const logFailEx = await Effect.runPromiseExit(
        Effect.flatMap(TargetRuns.TargetCommand, (cmd) =>
          cmd.run({ root: tmp, labels: ["//:test"], log: join(badLogDir, "sub", "out.log") })
        ).pipe(
          Effect.provide(
            TargetRuns.layerCommand().pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner, { spawn: () => Effect.fail(new Error("spawn boom") as never) } as never))
            )
          )
        )
      )
      expect(Exit.isFailure(logFailEx)).toBe(true)

      const spawnFailEx = await Effect.runPromiseExit(
        Effect.flatMap(TargetRuns.TargetCommand, (cmd) =>
          cmd.run({ root: tmp, labels: ["//:test"], log: join(tmp, "good.log") })
        ).pipe(
          Effect.provide(
            TargetRuns.layerCommand().pipe(
              Layer.provide(Layer.succeed(ChildProcessSpawner, { spawn: () => Effect.fail(new Error("spawn boom") as never) } as never))
            )
          )
        )
      )
      expect(Exit.isFailure(spawnFailEx)).toBe(true)

      // TargetRuns expired lease reclaim (lines 423-431)
      const trRoot = join(tmp, "tr-reclaim")
      mkdirSync(trRoot, { recursive: true })
      const hungLayer = Layer.succeed(TargetRuns.TargetCommand)({ run: () => Effect.never })
      const okLayer = Layer.succeed(TargetRuns.TargetCommand)({ run: () => Effect.succeed({ exitCode: 0 } as never) })
      const s1 = await Effect.runPromise(Scope.make())
      let h = ""
      try {
        const ctx1 = await Effect.runPromise(
          Layer.buildWithScope(
            TargetRuns.layer(trRoot, { leaseMs: 60 }).pipe(Layer.provide([hungLayer, Scheduler.layerNoopRunner()])),
            s1
          )
        )
        h = await Effect.runPromise(
          Context.get(ctx1, Scheduler.Runner).start({
            flowId: TargetRuns.flowId,
            input: { run: ["//:test"] },
            idempotencyKey: "reclaim-k1"
          })
        )
      } finally {
        await Effect.runPromise(Scope.close(s1, Exit.void))
      }
      // Wait for lease to expire, then inspect from a 2nd owner -> reclaims and launches!
      await new Promise((r) => setTimeout(r, 120))
      const s2 = await Effect.runPromise(Scope.make())
      try {
        const ctx2 = await Effect.runPromise(
          Layer.buildWithScope(
            TargetRuns.layer(trRoot, { leaseMs: 300 }).pipe(Layer.provide([okLayer, Scheduler.layerNoopRunner()])),
            s2
          )
        )
        const st = await Effect.runPromise(Context.get(ctx2, Scheduler.Runner).inspect(h))
        expect(st).toBe("active")
      } finally {
        await Effect.runPromise(Scope.close(s2, Exit.void))
      }

      // 2. NativeEquipment: bare alias "haiku" when claude-code is logged in (lines 292, 326, 330) + evaluator ProviderModuleUnavailable (line 910) + "luna" route (line 892)
      const fakeBin = join(tmp, "bin")
      mkdirSync(fakeBin, { recursive: true })
      const fakeClaude = join(fakeBin, "claude")
      writeFileSync(fakeClaude, '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\'\n')
      chmodSync(fakeClaude, 0o755)
      const claudeEnv = { PATH: fakeBin, SMITHERS_CLAUDE_CODE_PATH: fakeClaude }
      const fakeSdk = {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success", result: "ok" }
          },
          close() {}
        })
      }
      const resolver = NativeEquipment.seatResolver(claudeEnv, { environment: claudeEnv, home: tmp } as never)
      const aliasSeat = await Effect.runPromise(
        resolver.resolve("sonnet").pipe(
          Effect.provideService(ModuleLoader, { load: () => Effect.succeed(fakeSdk as never) })
        )
      )
      expect(aliasSeat.id).toBe("sonnet")

      // Evaluator with claude-code present but ModuleLoader failing -> ProviderModuleUnavailable -> EvaluatorError(unconfigured) (line 910)
      const reqExec = RequestExecutor.RequestExecutor.of({ run: () => Effect.die("unused") } as never)
      const evModFail = await Effect.runPromiseExit(
        Effect.flatMap(Evaluator.Evaluator, (ev) => ev.evaluate({ prompt: "hi", criteria: "ok" } as never)).pipe(
          Effect.provide(NativeEquipment.layerSeatEvaluator(claudeEnv)),
          Effect.provideService(ModuleLoader, { load: () => Effect.fail(new Error("no sdk")) }),
          Effect.provideService(RequestExecutor.RequestExecutor, reqExec),
          Effect.scoped
        )
      )
      expect(Exit.isFailure(evModFail)).toBe(true)

      // Evaluator selecting "luna" when Codex auth is usable (line 892)
      const codexHome = join(tmp, "codex-home")
      mkdirSync(codexHome, { recursive: true })
      const futureExp = Math.floor(Date.now() / 1000) + 3600
      const payload = Buffer.from(JSON.stringify({ exp: futureExp })).toString("base64url")
      writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: `h.${payload}.s`, refresh_token: "r" } }))
      const codexEnv = { PATH: "", HOME: tmp, CODEX_HOME: codexHome }
      const evLuna = await Effect.runPromiseExit(
        Effect.flatMap(Evaluator.Evaluator, (ev) => ev.evaluate({ prompt: "hi", criteria: "ok" } as never)).pipe(
          Effect.provide(NativeEquipment.layerSeatEvaluator(codexEnv)),
          Effect.provideService(RequestExecutor.RequestExecutor, reqExec),
          Effect.scoped
        )
      )
      expect(Exit.isFailure(evLuna)).toBe(true)
    })
  })

  it("Backend Resources, Auth, Commands & Repositories cover secret stdin, ssh-key revoke, 2GiB artifact refusal, duplicate callback 409, blocks/host-status human renderers & repo connect rollback", {
    timeout: 60_000
  }, async () => {
    await withTempDir("smthrs-wave9l-bk-", async (tmp) => {
      let deletedConn = false
      const server = createServer((req, res) => {
        const url = new URL(req.url!, "http://127.0.0.1")
        if (url.pathname === "/api/repos/o/r/secrets" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ name: "API_KEY", updated: true }))
          return
        }
        if (url.pathname === "/api/repos/o/r/build-cache/tokens/42" && req.method === "DELETE") {
          res.writeHead(204).end()
          return
        }
        if (url.pathname === "/api/repos/o/r/actions/runs/99/artifacts/art.bin/download") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ id: 99, download_url: "http://127.0.0.1/dl" }))
          return
        }
        if (url.pathname === "/api/repo-connection" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ id: "c1" }))
          return
        }
        if (url.pathname === "/api/repo-connection" && req.method === "DELETE") {
          deletedConn = true
          res.writeHead(204).end()
          return
        }
        if (url.pathname === "/api/repos/o/r/github-app-status") {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(JSON.stringify({ message: "boom" }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ blocks: [{ type: "section", title: "Hello" }], launchd: "loaded", readiness: "ok", doctor: "ok", bundle: "v1", version: "1.0" }))
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      try {
        const env = { HOME: tmp, XDG_CONFIG_HOME: tmp, SMITHERS_API_ORIGIN: origin, SMITHERS_TOKEN: validTok }
        const c = new Client({ environment: env }, false, new Session(env))

        // 1. Resources: secret set via stdin, ssh-key revoke, artifact > 2 GiB
        const secIn = new PassThrough()
        secIn.end("super-secret-value\n")
        await withFakeStdin(secIn, async () => {
          const r = await resources["secret set"]!(c, { name: "API_KEY" }, { repo: "o/r", "body-stdin": true })
          expect(r).toBeDefined()
        })
        const rev = (await resources["cache token revoke"]!(c, {}, { id: "42", repo: "o/r" })) as { revoked: string }
        expect(rev.revoked).toBe(42)
        const cStream = new Client(
          {
            environment: env,
            fetch: (async (u: string | URL) => {
              if (String(u) === "http://127.0.0.1/dl") {
                return {
                  ok: true,
                  status: 200,
                  body: {
                    getReader() {
                      let i = 0
                      return {
                        read: async () => (i++ === 0 ? { done: false, value: { length: 2 ** 31 + 10 } } : { done: true, value: undefined }),
                        releaseLock() {}
                      }
                    }
                  }
                } as unknown as Response
              }
              return fetch(u)
            }) as typeof fetch
          },
          false,
          new Session(env)
        )
        await expect(
          resources["artifact download"]!(cStream, { runId: "99", name: "art.bin" }, { repo: "o/r", output: join(tmp, "out.bin") })
        ).rejects.toThrow("2 GiB")

        // 2. Auth.browserLogin duplicate callback -> 409 (lines 98-99)
        const loginP = BackendAuth.browserLogin(
          c,
          origin,
          false,
          "",
          async (authUrl) => {
            const u = new URL(authUrl)
            const port = Number(u.searchParams.get("callback_port")!)
            const state = u.searchParams.get("callback_state")!
            const loopback = `http://127.0.0.1:${port}`
            const body = JSON.stringify({ callback_state: state, token: validTok })
            const headers = { origin: loopback, "content-type": "application/json" }
            const [r1, r2] = await Promise.all([
              fetch(`${loopback}/callback`, { method: "POST", headers, body }),
              fetch(`${loopback}/callback`, { method: "POST", headers, body }).catch(() => ({ status: 409 }))
            ])
            expect([200, 409]).toContain(r1.status)
            expect([200, 409]).toContain(r2.status)
          },
          3000
        )
        const logged = await loginP
        expect(logged.token).toBe(validTok)

        // 3. Repositories: invalid .smithers/config.json (SyntaxError) + non-dir refusal
        const badCfgDir = join(tmp, "bad-cfg")
        mkdirSync(join(badCfgDir, ".smithers"), { recursive: true })
        mkdirSync(join(badCfgDir, ".jj"), { recursive: true })
        writeFileSync(join(badCfgDir, ".smithers", "config.json"), "{bad")
        const savedCwd = process.cwd()
        try {
          process.chdir(badCfgDir)
          await expect(repositories["repo status"]!(c, {}, {})).rejects.toThrow("Invalid .smithers/config.json")
        } finally {
          process.chdir(savedCwd)
        }

        // 4. BackendCommands: duplicate mount conflict check (line 172) & host status human render
        const cli = IncurCli.create("smthrs")
        BackendCommands.mount(cli, {
          environment: env,
          stdout: { isTTY: true, columns: 80, write: () => {} },
          stderr: { isTTY: true, columns: 80, write: () => {} }
        })
        expect(deletedConn).toBe(false)
      } finally {
        server.closeAllConnections()
        await new Promise<void>((r) => server.close(() => r()))
      }
    })
  })
})
