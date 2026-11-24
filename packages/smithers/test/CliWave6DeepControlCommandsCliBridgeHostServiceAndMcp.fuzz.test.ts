import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Option, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as ControlBridge from "../src/cli/ControlBridge.ts"
import * as ControlCommands from "../src/cli/ControlCommands.ts"
import * as McpRemote from "../src/cli/McpRemote.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import * as Settlement from "../src/commands/Settlement.ts"
import * as Tui from "../src/commands/Tui.ts"
import * as HostService from "../src/internal/backend/HostService.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261133")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex")

describe("@smthrs/cli Wave-6B Deep HostService, McpRemote, Presentation, Tui, Settlement, ControlBridge & ControlCommands fuzz invariants", () => {
  it(
    "HostService bundle verification, launchd install/stop/maintenance/status/doctor, validateAddress & Unix socket setupURLs uphold security invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-hostsvc-deep-"))
      const bundleDir = join(tmp, "bundle")
      const stateDir = join(tmp, "state")
      const agentsDir = join(tmp, "LaunchAgents")
      mkdirSync(join(bundleDir, "bin"), { recursive: true })
      mkdirSync(join(stateDir, "run"), { recursive: true })
      mkdirSync(agentsDir, { recursive: true })

      // Loopback HTTP server for ready() and installTelemetry()
      let readyMode: "ok" | "fail" = "ok"
      const httpSrv = createServer((req, res) => {
        if (req.url === "/api/install") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        if (readyMode === "ok") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ status: "ok" }))
        } else {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "booting" }))
        }
      })
      await new Promise<void>((r) => httpSrv.listen(0, "127.0.0.1", () => r()))
      const httpOrigin = `http://127.0.0.1:${(httpSrv.address() as AddressInfo).port}`

      // Real Unix domain socket server for HostService.setupURLs!
      const sockPath = join(stateDir, "run", "host.sock")
      let sockMode: "ready" | "closed" | "mint_failed" | "bad_json" = "ready"
      const unixSrv = createServer((_req, res) => {
        if (sockMode === "ready") {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ setup_urls: ["http://127.0.0.1:4000/setup?token=tok123"] }))
        } else if (sockMode === "closed") {
          res.writeHead(401, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "setup_closed" }))
        } else if (sockMode === "mint_failed") {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "setup_mint_failed" }))
        } else {
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{not-json")
        }
      })
      await new Promise<void>((r) => unixSrv.listen(sockPath, () => r()))
      chmodSync(sockPath, 0o600)

      try {
        // 1. Build valid bundle with real sha256 manifest
        const bins = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"]
        const files: Array<{ path: string; sha256: string; stage: string; mode: number }> = []
        for (const rel of bins) {
          const full = join(bundleDir, rel)
          const content = `#!/bin/sh\necho ${rel}\n`
          writeFileSync(full, content)
          chmodSync(full, 0o755)
          files.push({ path: rel, sha256: sha256(content), stage: "bin", mode: 0o755 })
        }
        const rev = "a".repeat(40)
        const validManifest = { version: 1, platform: "darwin-arm64", revision: rev, files }
        writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(validManifest))

        const verified = HostService.verifyBundle(bundleDir)
        expect(verified.version).toBe(rev)
        expect(HostService.resolveBundle(bundleDir)).toBe(bundleDir)
        expect(() => HostService.resolveBundle(undefined, join(tmp, "missing-keg"))).toThrow()

        // Negative manifest cases: bad version, empty files, escaping path, hash mismatch, extra file
        writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify({ ...validManifest, version: 2 }))
        expect(() => HostService.verifyBundle(bundleDir)).toThrow()
        writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify({ ...validManifest, files: [] }))
        expect(() => HostService.verifyBundle(bundleDir)).toThrow()
        writeFileSync(
          join(bundleDir, "manifest.json"),
          JSON.stringify({ ...validManifest, files: [{ ...files[0]!, path: "../evil" }] })
        )
        expect(() => HostService.verifyBundle(bundleDir)).toThrow()
        writeFileSync(
          join(bundleDir, "manifest.json"),
          JSON.stringify({ ...validManifest, files: [{ ...files[0]!, sha256: "0".repeat(64) }, ...files.slice(1)] })
        )
        expect(() => HostService.verifyBundle(bundleDir)).toThrow()
        // Restore valid manifest, add undeclared file
        writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(validManifest))
        writeFileSync(join(bundleDir, "extra.txt"), "sneaky")
        expect(() => HostService.verifyBundle(bundleDir)).toThrow()
        rmSync(join(bundleDir, "extra.txt"))

        // 2. plist, hostPlist, stateDirectory, launchd install/stop/installedBundle/maintenance/status/doctor
        expect(HostService.stateDirectory(tmp)).toContain("Smithers")
        const plistXml = HostService.plist({
          Label: HostService.label,
          RunAtLoad: true,
          KeepAlive: { SuccessfulExit: false },
          ProgramArguments: ["/bin/true"]
        })
        expect(plistXml).toContain("<plist")
        const hp = HostService.hostPlist({ bundle: bundleDir, stateDir, home: tmp })
        expect(hp).toContain(HostService.label)

        let isLoaded = false
        const system: HostService.Launchd = {
          domain: "gui/501",
          agentsDir,
          launchctl: (args) => {
            if (args[0] === "print") return { status: isLoaded ? 0 : 1, stdout: "", stderr: "" }
            if (args[0] === "bootstrap") {
              isLoaded = true
              return { status: 0, stdout: "", stderr: "" }
            }
            if (args[0] === "bootout") {
              isLoaded = false
              return { status: 0, stdout: "", stderr: "" }
            }
            return { status: 0, stdout: "", stderr: "" }
          }
        }

        expect(HostService.loaded(system)).toBe(false)
        const inst1 = await HostService.install({ bundle: bundleDir, stateDir, home: tmp }, system)
        expect(inst1).toBe("installed")
        const inst2 = await HostService.install({ bundle: bundleDir, stateDir, home: tmp }, system)
        expect(inst2).toBe("unchanged")
        expect(HostService.loaded(system)).toBe(true)
        expect(HostService.installedBundle(system)).toBe(verified.bundle)

        const st = await HostService.status(system, stateDir, httpOrigin, "tok-1")
        expect(st.state).toBe("ready")
        const bkp = HostService.maintenance(
          "backup",
          join(tmp, "bkp"),
          system,
          (() => ({ status: 0, stdout: "ok", stderr: "" })) as any
        )
        expect(bkp).toBe("ok")
        expect(() => HostService.maintenance("restore", join(tmp, "bkp"), system)).toThrow()
        const stopped = await HostService.stop(system)
        expect(stopped.state).toBe("stopped")
        expect(() => HostService.maintenance("restore", "", system)).toThrow()

        // ready, waitReady, startRefusal, startText, validateAddress, installTelemetry, doctor
        readyMode = "ok"
        expect(await HostService.ready(httpOrigin)).toBe(true)
        await HostService.waitReady(async () => true, 500)
        readyMode = "fail"
        expect(await HostService.ready(httpOrigin)).not.toBe(true)
        await expect(HostService.waitReady(async () => false, 30)).rejects.toThrow()

        expect(HostService.startRefusal(stateDir)).toBeUndefined()
        expect(HostService.startText({ state: "running", setup_urls: ["http://127.0.0.1:4000"] })).toContain(
          "http://127.0.0.1:4000"
        )
        HostService.validateAddress({ bind: "127.0.0.1:4000", origins: ["http://127.0.0.1:4000"] })
        expect(() => HostService.validateAddress({ bind: "bad-bind-no-port" })).toThrow()
        expect(() => HostService.validateAddress({ origins: ["not-a-url"] })).toThrow()
        await HostService.installTelemetry(`${httpOrigin}/api/install`, "tok-1")
        HostService.doctor(bundleDir, stateDir, (() => ({ status: 0, stdout: "", stderr: "" })) as any)

        // 3. Unix socket setupURLs (all 4 responses + bad permissions refusal!)
        sockMode = "ready"
        const u1 = await HostService.setupURLs(stateDir, 2000)
        expect(u1.code).toBe("setup_ready")
        sockMode = "closed"
        const u2 = await HostService.setupURLs(stateDir, 2000)
        expect(u2.code).toBe("setup_closed")
        sockMode = "mint_failed"
        const u3 = await HostService.setupURLs(stateDir, 2000)
        expect(u3.code).toBe("setup_mint_failed")
        sockMode = "bad_json"
        await expect(HostService.setupURLs(stateDir, 2000)).rejects.toThrow()
        chmodSync(sockPath, 0o644)
        await expect(HostService.setupURLs(stateDir, 2000)).rejects.toThrow(/0600/)
      } finally {
        await new Promise<void>((r) => unixSrv.close(() => r()))
        await new Promise<void>((r) => httpSrv.close(() => r()))
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "McpRemote stdio bridge & token store, Presentation formatting, Tui launcher & Settlement state machines uphold invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-mcp-pres-tui-set-"))
      // Loopback MCP Streamable HTTP server
      let mcpRespMode: "json" | "sse" | "401" | "500" = "json"
      const mcpSrv = createServer((req, res) => {
        let body = ""
        req.on("data", (c) => (body += c.toString()))
        req.on("end", () => {
          if (mcpRespMode === "401") {
            res.writeHead(401, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "unauthorized" }))
            return
          }
          if (mcpRespMode === "500") {
            res.writeHead(500, { "content-type": "text/plain" })
            res.end("boom")
            return
          }
          const parsed = JSON.parse(body || "{}")
          if (mcpRespMode === "sse") {
            res.writeHead(200, { "content-type": "text/event-stream" })
            res.end(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { sse: true } })}\n\n`
            )
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } }))
        })
      })
      await new Promise<void>((r) => mcpSrv.listen(0, "127.0.0.1", () => r()))
      const mcpOrigin = `http://127.0.0.1:${(mcpSrv.address() as AddressInfo).port}`

      try {
        // 1. McpRemote token store + serveMcpStdioBridge across JSON, SSE, 401, 500, invalid JSON
        expect(McpRemote.normalizeOrigin(mcpOrigin)).toBe(mcpOrigin)
        expect(McpRemote.normalizeRepo("acme/demo")).toBe("acme/demo")
        expect(McpRemote.mcpEndpointUrl(mcpOrigin, "acme/demo")).toContain("/mcp")
        const tokFile = McpRemote.tokenStorePath({ XDG_CONFIG_HOME: tmp })
        const validToken = `sma_${"a".repeat(64)}`
        McpRemote.writeStoredToken(tokFile, {
          origin: mcpOrigin,
          repo: "acme/demo",
          token: validToken,
          expiresAt: null
        } as any)
        expect(McpRemote.readStoredToken(tokFile, mcpOrigin, "acme/demo")?.token).toBe(validToken)

        for (const mode of ["json", "sse", "401", "500"] as const) {
          mcpRespMode = mode
          const input = new PassThrough()
          const output = new PassThrough()
          const outChunks: Array<string> = []
          output.on("data", (c) => outChunks.push(c.toString()))
          const errChunks: Array<string> = []
          const bridgePromise = McpRemote.serveMcpStdioBridge({
            origin: mcpOrigin,
            repo: "acme/demo",
            storePath: tokFile,
            input,
            output,
            stderr: { write: (s) => errChunks.push(s) }
          })
          input.write("not-json\n")
          input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n")
          input.end()
          await bridgePromise
          expect(outChunks.join("")).toContain("-32700")
        }

        // 2. Presentation: withErrorEnvelope, policy, scope, current, runs, nextActions, clean, finish, fail, guard
        const envOut: Array<string> = []
        const envErr = await Presentation.withErrorEnvelope(
          (text) => {
            envOut.push(text)
          },
          async (write) => {
            write(JSON.stringify({ error: { message: "bad" } }))
            return "wrapped"
          }
        )
        expect(envErr).toBe("wrapped")
        expect(Presentation.clean("\x1b[31mhello\x1b[0m")).toBe("hello")
        expect(typeof Presentation.clean(new Error("\x1b[32mval\x1b[0m"))).toBe("string")
        expect(Presentation.nextActions({ runId: "r-1", status: "parked" }, {}, Presentation.runs())).toBeDefined()
        await Presentation.scope({ format: "json" } as any, {}, async () => {
          expect(Presentation.current()).toBeDefined()
          const finished = Presentation.finish(
            { format: "json" } as any,
            { ok: true },
            { text: () => "ok text" } as any
          )
          expect(finished).toEqual({ ok: true })
          const guarded = await Presentation.guard({ format: "json" } as any, async () => 42)
          expect(guarded).toBe(42)
        })
        const pol = Presentation.policy({ format: "toon" } as any, {})
        expect(pol).toBeDefined()

        // 3. Tui: argv, binaryPackages, checkout, entry, launch (all 5 branches) & run (real tiny binary!)
        const tuiArgs = Tui.argv({
          root: tmp,
          remote: "http://127.0.0.1:4000",
          print: "hello",
          resume: "r-1",
          seat: "claude:sonnet",
          json: true
        } as any)
        expect(tuiArgs.length).toBeGreaterThan(0)

        const fakeMachine = (overrides: Partial<Tui.Host>): Tui.Host => ({
          ...Tui.host,
          platform: "linux",
          arch: "x64",
          versions: { node: "22.0.0" },
          execPath: process.execPath,
          exists: () => false,
          packageDirectory: () => undefined,
          avx2: () => true,
          musl: () => false,
          ...overrides
        })
        expect(Tui.binaryPackages(fakeMachine({ platform: "darwin", arch: "arm64" })).length).toBeGreaterThan(0)
        expect(
          Tui.binaryPackages(fakeMachine({ platform: "linux", arch: "x64", avx2: () => false, musl: () => true }))
            .length
        ).toBeGreaterThan(0)
        expect(
          Tui.binaryPackages(fakeMachine({ platform: "linux", arch: "x64", avx2: () => true, musl: () => false }))
            .length
        ).toBeGreaterThan(0)
        const pkgUrl = new URL(`file://${tmp}/`)
        expect(Tui.launch({ SMITHERS_TUI_BIN: "/bin/true" }, pkgUrl, fakeMachine({}) as any)).toMatchObject({
          runtime: "binary"
        })
        expect(Tui.launch({ SMITHERS_BUN: "/usr/bin/bun" }, pkgUrl, fakeMachine({}) as any)).toMatchObject({
          runtime: "bun"
        })
        expect(Tui.launch({}, pkgUrl, fakeMachine({ versions: { node: "26.5.0" } }) as any)).toMatchObject({
          runtime: "node"
        })
        expect(Tui.launch({}, pkgUrl, fakeMachine({ versions: { node: "22.0.0" } }) as any)).toBeInstanceOf(Error)
        expect(
          Tui.launch(
            {},
            pkgUrl,
            fakeMachine({
              exists: (p) => p.endsWith("smithers-tui"),
              packageDirectory: () => "/opt/tui"
            }) as any
          )
        ).toMatchObject({ runtime: "binary" })

        const fakeTuiBin = join(tmp, "fake-tui.cjs")
        writeFileSync(fakeTuiBin, `#!${process.execPath}\nprocess.exit(Number(process.env.FAKE_TUI_CODE || "0"))\n`)
        chmodSync(fakeTuiBin, 0o755)
        expect(await Tui.run({}, { SMITHERS_TUI_BIN: fakeTuiBin, FAKE_TUI_CODE: "0" }, pkgUrl)).toBe(0)
        expect(await Tui.run({}, { SMITHERS_TUI_BIN: fakeTuiBin, FAKE_TUI_CODE: "7" }, pkgUrl)).toBe(7)

        // 4. Settlement: settled, watchFailure, latestSequence, latestPark, latestResumablePark, decisionPark, declined, wasDeclined, status, report, receiptDocument, awaitRun, awaitHandOff
        const kindsArb = Arbitrary.schema(
          Schema.Literals([
            "control.run.completed",
            "control.run.failed",
            "control.run.cancelled",
            "control.run.waiting-approval",
            "control.run.running",
            "control.run.pending"
          ])
        )
        const setRep = await Effect.runPromise(
          Fuzz.run(
            kindsArb,
            (kind) =>
              Effect.sync(() => {
                const s = {
                  kind,
                  sequence: 1,
                  event: { sequence: 1, runId: "r-1", timestamp: 1, kind, payload: {} }
                } as any
                const st = Settlement.status(s)
                assertInv(st === undefined || typeof st === "number", "status is number or undefined")
                const doc = Settlement.receiptDocument({ _tag: "Accepted", runId: "r-1" } as any, s)
                assertInv(doc !== null && typeof doc === "object", "receiptDocument returns object")
                assertInv(Settlement.wasDeclined(s) === (kind === "control.run.pending"), "wasDeclined matches pending")
                return true
              }),
            { executions: Math.min(executions, 30), seed }
          )
        )
        expect(setRep._tag).toBe("Passed")

        const sampleEvents = [
          {
            sequence: 1,
            runId: "r-1",
            timestamp: 100,
            kind: "control.run.waiting-approval",
            payload: { approvalId: "ap-1", waitingReason: "approval" }
          },
          { sequence: 2, runId: "r-1", timestamp: 200, kind: "control.run.completed", payload: { output: "ok" } }
        ]
        const mockControl: any = {
          getRun: () => Effect.succeed({ runId: "r-1", status: "completed", flowId: "demo" }),
          run: () => Effect.succeed({ runId: "r-1", status: "completed", flowId: "demo" }),
          listEvents: () => Effect.succeed(sampleEvents),
          watch: (q?: any) =>
            Stream.fromIterable(
              sampleEvents.filter((e) => q?.afterSequence === undefined || e.sequence > q.afterSequence)
            )
        }
        const lp = await Effect.runPromise(Settlement.latestPark(mockControl, "r-1"))
        expect(lp).toBeDefined()
        const lrp = await Effect.runPromise(Settlement.latestResumablePark(mockControl, "r-1"))
        expect(lrp).toBeDefined()
        const ar0 = await Effect.runPromise((Settlement.awaitRun as any)(mockControl, "r-1", 0))
        expect((ar0 as any)?.kind).toBe("control.run.waiting-approval")
        const ar = await Effect.runPromise((Settlement.awaitRun as any)(mockControl, "r-1", 1))
        expect((ar as any)?.kind).toBe("control.run.completed")
        const rc = Settlement.releasedCause("r-1", "demo", sampleEvents as any)
        expect(rc).toContain("r-1")
        const dp = await Effect.runPromise(
          Settlement.decisionPark(mockControl, { _tag: "Node", runId: "r-1", nodeId: "n1" } as any)
        )
        expect(dp).toBeDefined()
        const dpPlan = await Effect.runPromise(
          Settlement.decisionPark(mockControl, { _tag: "Plan", planId: "p1" } as any)
        )
        expect(dpPlan).toBeUndefined()
        expect(Settlement.declined("r-1", { runId: "r-1", flowId: "demo", status: "pending" } as any)).toBeInstanceOf(
          Error
        )
        expect((Settlement.watchFailure as any)("r-1", new Error("stream dropped"))).toBeDefined()
        expect(Settlement.report(ar as any)).toBeDefined()

        // 5. ControlBridge & ControlCommands against a real temp workspace
        const wsDir = join(tmp, "ctrl-ws")
        mkdirSync(join(wsDir, ".flows"), { recursive: true })
        expect(ControlBridge.connectionArguments({ root: wsDir, remote: "http://127.0.0.1:8080", quiet: false }))
          .toContain("--root")
        expect(ControlBridge.isRemote({ remote: "http://127.0.0.1:8080", quiet: false }, {})).toBe(true)
        expect(ControlBridge.hasRecords({ root: wsDir, quiet: false }, {})).toBe(false)
        expect(ControlBridge.failureOf(Cause.fail(new Error("boom")), undefined)).toBeInstanceOf(Error)
        const aborted = new AbortController()
        aborted.abort()
        expect(ControlBridge.failureOf(Cause.interrupt(0 as any), aborted.signal)).toBeDefined()

        // Exercise ControlCommands CLI builders
        const flowCli = ControlCommands.createFlowCli({ environment: { HOME: tmp } })
        const runsCli = ControlCommands.createRunsCli({ environment: { HOME: tmp } })
        const apprCli = ControlCommands.createApprovalsCli({ environment: { HOME: tmp } })
        expect(flowCli).toBeDefined()
        expect(runsCli).toBeDefined()
        expect(apprCli).toBeDefined()

        const runServe = async (cli: any, argv: Array<string>) => {
          let code = 0
          let out = ""
          await cli.serve(argv, {
            stdout: (s: string) => {
              out += s
            },
            exit: (c: number) => {
              code = c
            }
          })
          return { code, out }
        }

        const runListRes = await runServe(runsCli, ["list", "--root", wsDir, "--format", "json"])
        expect(runListRes.code).toBe(0)
        const flowListRes = await runServe(flowCli, ["list", "--root", wsDir, "--format", "json"])
        expect(flowListRes.code).toBe(0)
        const apprListRes = await runServe(apprCli, ["list", "--root", wsDir, "--format", "json"])
        expect(apprListRes.code).toBe(0)
        // Also exercise ControlBridge.invoke -> Command.cli directly across subcommands!
        const bridgedLs = await ControlBridge.invoke(["ls"], { root: wsDir, quiet: false }, {
          environment: { HOME: tmp }
        })
        expect(bridgedLs).toBeDefined()
        const bridgedWf = await ControlBridge.invoke(["workflow", "list"], { root: wsDir, quiet: false }, {
          environment: { HOME: tmp }
        })
        expect(bridgedWf).toBeDefined()
        const bridgedPs = await ControlBridge.invoke(["ps"], { root: wsDir, quiet: false }, {
          environment: { HOME: tmp }
        })
        expect(bridgedPs).toBeDefined()
        const bridgedDoctor = await ControlBridge.invoke(["doctor"], { root: wsDir, quiet: false }, {
          environment: { HOME: tmp }
        })
        expect(bridgedDoctor).toBeDefined()
        for (
          const failArgs of [
            ["status", "missing-run"],
            ["why", "missing-run"],
            ["logs", "missing-run"],
            ["events", "missing-run"],
            ["output", "missing-run"],
            ["cancel", "missing-run"]
          ]
        ) {
          await expect(ControlBridge.invoke(failArgs, { root: wsDir, quiet: false }, { environment: { HOME: tmp } }))
            .rejects.toThrow()
        }
        // Missing run commands exercise error-mapping branches in ControlCommands cleanly
        for (
          const argv of [
            ["show", "missing-run", "--root", wsDir, "--format", "json"],
            ["inspect", "missing-run", "--root", wsDir, "--format", "json"],
            ["verify", "missing-run", "--root", wsDir, "--format", "json"],
            ["timing", "missing-run", "--root", wsDir, "--format", "json"],
            ["cancel", "missing-run", "--root", wsDir, "--format", "json"]
          ]
        ) {
          const res = await runServe(runsCli, argv)
          expect(res.code).not.toBe(0)
        }
      } finally {
        await new Promise<void>((r) => mcpSrv.close(() => r()))
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )
})
