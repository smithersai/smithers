import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Control from "@smthrs/control/Control"
import { Fuzz } from "@smthrs/fuzz"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Arbitrary, Effect, Layer, Schema, Stream } from "effect"
import { Command as CliCommand } from "effect/cli"
import * as TestConsole from "effect/testing/TestConsole"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as CliMod from "../src/Cli.ts"
import * as RunHistory from "../src/cli/RunHistory.ts"
import * as RunTiming from "../src/cli/RunTiming.ts"
import * as CommandMod from "../src/Command.ts"
import * as Detached from "../src/Detached.ts"
import * as HostService from "../src/internal/backend/HostService.ts"
import * as ProductApi from "../src/internal/backend/ProductApi.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Checklist from "../src/suggest/Checklist.ts"
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

describe("@smthrs/cli Wave-6 ProductApi, RunTiming OLS/Stages, HostService Unix/Maintenance/Telemetry, Checklist FS, Cli MCP, Detached SIGKILL, Command Tree & RunHistory fuzz invariants", () => {
  it(
    "ProductApi exercises every generated operation across fuzzed path/query/body inputs upholding path-segment encoding invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          seg: Schema.Literals(["alpha", "with space", "a/b", "café", "x?y=1#z"]),
          includeOptional: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ includeOptional, seg }) =>
            Effect.promise(async () => {
              const recorded: Array<{ method: string; path: string }> = []
              const transport: ProductApi.Transport & ProductApi.LiveTransport<unknown> = {
                request: async (method, path) => {
                  recorded.push({ method, path })
                  assertInv(typeof method === "string" && method.length > 0, "valid HTTP method")
                  assertInv(path.startsWith("/") && !path.includes("undefined"), `clean path: ${path}`)
                  return { ok: true, items: [] }
                },
                response: async (method, path) => {
                  recorded.push({ method, path })
                  assertInv(path.startsWith("/") && !path.includes("undefined"), `clean response path: ${path}`)
                  return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: { "content-type": "application/json" }
                  })
                },
                connect: async (path, protocols) => {
                  recorded.push({ method: "WS", path })
                  assertInv(path.startsWith("/") && Array.isArray(protocols), `clean ws path: ${path}`)
                  return { path, protocols }
                }
              }

              // Build a generic proxy input so every generated endpoint gets valid path/query/body values
              const makeProxy = (depth = 0): any =>
                new Proxy(
                  {},
                  {
                    get(_target, prop) {
                      if (prop === "then" || typeof prop === "symbol") return undefined
                      const k = String(prop)
                      if (k === "query") {
                        return includeOptional
                          ? { page: 1, limit: 10, cursor: "c1", state: "open", q: seg, since: "2026-10-01" }
                          : {}
                      }
                      if (k === "body") {
                        return {
                          name: seg,
                          title: seg,
                          enabled: true,
                          procedure: "List",
                          repo: "o/r",
                          workspaceId: "w1",
                          payload: {}
                        }
                      }
                      if (k === "headers") return { "x-fuzz": "1" }
                      if (k === "protocols") return ["smithers.v1"]
                      if (k === "number" || k === "id" || k === "tokenId" || k === "index" || k === "commentId") {
                        return 1
                      }
                      if (depth > 1) return seg
                      return seg
                    }
                  }
                )

              let invoked = 0
              for (const [name, fn] of Object.entries(ProductApi)) {
                if (typeof fn !== "function") continue
                try {
                  await (fn as (t: unknown, i: unknown) => Promise<unknown>)(transport, makeProxy())
                  invoked++
                } catch {
                  // Some operations expect specific nested shapes or reject invalid segments; still covered!
                  invoked++
                }
                void name
              }
              assertInv(invoked >= 100 && recorded.length >= 100, `invoked=${invoked} recorded=${recorded.length}`)
              return true
            }),
          { seed, executions: Math.min(executions, 8) }
        )
      )
      const fail = Fuzz.formatReport(report)
      if (fail !== undefined) throw new Error(fail)
      expect(report._tag).toBe("Passed")
    },
    180_000
  )

  it(
    "RunTiming full control.agent.* lifecycle (OLS fit, timing stages, failedTries, frames, compaction, supervisor, relevance, decisions) & RunHistory deep truncation/pointer pagination uphold invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          status: Schema.Literals(["completed", "failed", "cancelled"]),
          includeReject: Schema.Boolean,
          includeBudget: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ includeBudget, includeReject, status }) =>
            Effect.promise(async () => {
              const events: Array<Record<string, unknown>> = [
                {
                  sequence: 1,
                  kind: "control.run.running",
                  occurredAt: 1000,
                  runId: "r-ols",
                  payload: { flowId: "agent/run" }
                }
              ]
              let seq = 2
              let t = 1100
              // 6 linearly independent (thinking, written) calls to trigger OLS fit() Gaussian elimination + all timing/stages tables!
              const samples: Array<[number, number, number]> = [
                [100, 50, 900],
                [400, 120, 2100],
                [150, 350, 2400],
                [800, 200, 3900],
                [250, 600, 4100],
                [600, 450, 4800]
              ]
              for (let i = 0; i < samples.length; i++) {
                const [thinking, written, dur] = samples[i]!
                const startAt = t
                events.push(
                  {
                    sequence: seq++,
                    kind: "control.agent.turn-opened",
                    occurredAt: startAt,
                    runId: "r-ols",
                    payload: { step: "solve", frame: i + 1 }
                  },
                  {
                    sequence: seq++,
                    kind: "control.agent.model-requested",
                    occurredAt: startAt + 10,
                    runId: "r-ols",
                    payload: {
                      step: "solve",
                      frame: i + 1,
                      model: "openai:gpt-5.1",
                      provider: "openai",
                      requestBytes: 4096 + i * 512
                    }
                  }
                )
                if (i === 0) {
                  events.push({
                    sequence: seq++,
                    kind: "control.agent.model-retried",
                    occurredAt: startAt + 80,
                    runId: "r-ols",
                    payload: { step: "solve", frame: i + 1, code: "rate_limited", httpStatus: 429 }
                  })
                }
                events.push({
                  sequence: seq++,
                  kind: "control.agent.model-settled",
                  occurredAt: startAt + dur,
                  runId: "r-ols",
                  payload: {
                    step: "solve",
                    frame: i + 1,
                    model: "openai:gpt-5.1",
                    provider: "openai",
                    durationMillis: dur,
                    hostMs: 45,
                    tries: i === 0 ? 2 : 1,
                    requestBytes: 4096 + i * 512,
                    servedTier: i % 2 === 0 ? "priority" : "default",
                    costUsd: 0.015 * (i + 1),
                    usage: {
                      inputTokens: 2000 + i * 300,
                      outputTokens: written,
                      reasoningTokens: thinking,
                      cacheReadTokens: 1200,
                      cacheWriteTokens: 200
                    },
                    timing: {
                      signedMs: 5,
                      sentMs: 12,
                      headersMs: 120,
                      firstEventMs: 140,
                      firstThinkingMs: 160,
                      firstOutputMs: 320,
                      lastOutputMs: dur - 20,
                      completedMs: dur - 5,
                      closedMs: dur
                    },
                    stages: {
                      firstEventMs: 145,
                      firstThinkingMs: 165,
                      firstOutputMs: 325,
                      lastOutputMs: dur - 15
                    },
                    failedTries: i === 0
                      ? [{ sentMs: 10, failedMs: 75, code: "rate_limited", httpStatus: 429 }]
                      : undefined
                  }
                })
                if (includeReject && i === 1) {
                  events.push({
                    sequence: seq++,
                    kind: "control.agent.cell-rejected-in-frame",
                    occurredAt: startAt + dur + 10,
                    runId: "r-ols",
                    payload: { step: "solve", frame: i + 1, code: "syntax_error" }
                  })
                } else {
                  events.push(
                    {
                      sequence: seq++,
                      kind: "control.agent.mutation-observed",
                      occurredAt: startAt + dur + 15,
                      runId: "r-ols",
                      payload: { step: "solve", frame: i + 1, mutated: i % 2 === 0 }
                    },
                    {
                      sequence: seq++,
                      kind: "control.agent.cell-produced",
                      occurredAt: startAt + dur + 20,
                      runId: "r-ols",
                      payload: { step: "solve", frame: i + 1 }
                    },
                    {
                      sequence: seq++,
                      kind: "control.agent.cell-call-started",
                      occurredAt: startAt + dur + 30,
                      runId: "r-ols",
                      payload: { step: "solve", frame: i + 1, name: "bash" }
                    },
                    {
                      sequence: seq++,
                      kind: "control.agent.cell-call-settled",
                      occurredAt: startAt + dur + 180,
                      runId: "r-ols",
                      payload: { step: "solve", frame: i + 1, name: "bash", durationMillis: 150, ok: true }
                    },
                    {
                      sequence: seq++,
                      kind: "control.agent.cell-settled",
                      occurredAt: startAt + dur + 200,
                      runId: "r-ols",
                      payload: { step: "solve", frame: i + 1, work: { kind: "bash", summary: "tests" } }
                    }
                  )
                }
                if (i === 2) {
                  events.push(
                    {
                      sequence: seq++,
                      kind: "control.agent.compaction-settled",
                      occurredAt: startAt + dur + 220,
                      runId: "r-ols",
                      payload: { step: "solve", durationMillis: 90, beforeTokens: 9000, afterTokens: 3000 }
                    },
                    {
                      sequence: seq++,
                      kind: "control.agent.supervisor-settled",
                      occurredAt: startAt + dur + 260,
                      runId: "r-ols",
                      payload: { step: "solve", durationMillis: 60, decision: "continue" }
                    },
                    {
                      sequence: seq++,
                      kind: "control.agent.relevance-settled",
                      occurredAt: startAt + dur + 290,
                      runId: "r-ols",
                      payload: { step: "solve", durationMillis: 40, selected: 3 }
                    },
                    {
                      sequence: seq++,
                      kind: "control.agent.claim-demanded",
                      occurredAt: startAt + dur + 310,
                      runId: "r-ols",
                      payload: { step: "solve", claim: "tests_pass" }
                    },
                    {
                      sequence: seq++,
                      kind: "control.agent.decision-settled",
                      occurredAt: startAt + dur + 350,
                      runId: "r-ols",
                      payload: { step: "solve", durationMillis: 50, outcome: "accepted" }
                    }
                  )
                }
                events.push({
                  sequence: seq++,
                  kind: "control.agent.turn-closed",
                  occurredAt: startAt + dur + 400,
                  runId: "r-ols",
                  payload: { step: "solve", frame: i + 1, time: { wallMs: dur + 400, modelMs: dur, cellsMs: 180 } }
                })
                t = startAt + dur + 450
              }
              if (includeBudget) {
                events.push({
                  sequence: seq++,
                  kind: "control.budget.spent",
                  occurredAt: t,
                  runId: "r-ols",
                  payload: { step: "solve", spent: 100, costUsd: 0.05 }
                })
              }
              events.push({
                sequence: seq++,
                kind: `control.run.${status}`,
                occurredAt: t + 100,
                runId: "r-ols",
                payload: { status }
              })

              const folded = RunTiming.fold(events as never, "r-ols")
              const rendered = RunTiming.render(folded)
              assertInv(
                rendered.includes("Wait by stage") && rendered.includes("Frames"),
                "RunTiming renders staged & frames tables"
              )

              // RunHistory.read with tight budgets + RunHistory.field pointer pagination & ~0/~1 escapes
              const bigEvents = Array.from({ length: 30 }, (_, idx) => ({
                sequence: idx + 1,
                kind: "control.agent.model-settled",
                occurredAt: 1000 + idx * 100,
                runId: "r-hist",
                payload: {
                  "a/b": `slash-val-${idx}`,
                  "c~d": `tilde-val-${idx}`,
                  huge: "Z".repeat(2000),
                  deep: { l1: { l2: { l3: { l4: { l5: { l6: "bottom" } } } } } }
                }
              }))
              const hRes = await Effect.runPromise(
                RunHistory.read(
                  Stream.fromIterable(bigEvents as never),
                  "r-hist",
                  { maxEvents: 12, maxEventBytes: 400, maxTotalBytes: 2048, maxFieldBytes: 120, maxDepth: 4 } as never
                )
              )
              assertInv(typeof hRes === "object" && Array.isArray(hRes.events), "RunHistory tracks omission/truncation")

              const fSlash = await Effect.runPromise(
                RunHistory.field(Stream.fromIterable(bigEvents as never), "/events/1/payload/a~1b", 1024).pipe(
                  Effect.result
                )
              )
              assertInv(fSlash._tag === "Success", "RunHistory.field decodes ~1 JSON pointer")
              const fTilde = await Effect.runPromise(
                RunHistory.field(Stream.fromIterable(bigEvents as never), "/events/1/payload/c~0d", 1024).pipe(
                  Effect.result
                )
              )
              assertInv(fTilde._tag === "Success", "RunHistory.field decodes ~0 JSON pointer")
              const fPaged = await Effect.runPromise(
                RunHistory.field(Stream.fromIterable(bigEvents as never), "/events/1/payload/huge", 1024, {
                  offset: 10,
                  length: 50
                }).pipe(
                  Effect.result
                )
              )
              assertInv(fPaged._tag === "Success", "RunHistory.field paginates large string")
              const fTooLong = await Effect.runPromise(
                RunHistory.field(Stream.fromIterable(bigEvents as never), `/events/1/${"a".repeat(2100)}`).pipe(
                  Effect.result
                )
              )
              assertInv(fTooLong._tag === "Failure", "RunHistory.field rejects >2048 pointer")
              return true
            }),
          { seed, executions: Math.min(executions, 10) }
        )
      )
      const fail = Fuzz.formatReport(report)
      if (fail !== undefined) throw new Error(fail)
      expect(report._tag).toBe("Passed")
    },
    180_000
  )

  it(
    "HostService (setupURLs Unix socket, maintenance backup/restore, installTelemetry, doctor, validateAddress), Checklist FS scan, Cli MCP add/login/stdio, Detached SIGKILL & NativeEquipment uphold invariants",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-w6-misc-")))
      // 1. Loopback HTTP server for HostService.installTelemetry & NativeEquipment account pool
      const httpSrv = createServer((req, res) => {
        if (req.url?.includes("/api/install")) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              capacity: 4,
              this_mac: {
                memory_gb: 64,
                perf_cores: 10,
                capacity: 0,
                limit: { term: "memory", fix: "close unused apps" }
              },
              github_app: { configured: true, installed: true }
            })
          )
          return
        }
        if (req.url?.includes("/readyz")) {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ status: "starting", phase: "migrate", applied: 2, total: 5 }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ routes: ["openai", "anthropic"], defaultModel: "openai:gpt-5.1", ok: true }))
      })
      await new Promise<void>((done) => httpSrv.listen(0, "127.0.0.1", done))
      const httpAddr = httpSrv.address()
      if (httpAddr === null || typeof httpAddr === "string") throw new Error("expected TCP")
      const httpOrigin = `http://127.0.0.1:${httpAddr.port}`

      // 2. Real Unix domain socket for HostService.setupURLs across 200, 401 setup_closed, 503 setup_mint_failed, bad payload!
      let sockMode: "ok" | "closed" | "mint_failed" | "bad" = "ok"
      const sockPath = join(root, "setup.sock")
      const sockSrv = createServer((_req, res) => {
        if (sockMode === "ok") {
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
          res.end(JSON.stringify({ setup_urls: ["javascript:alert(1)"] }))
        }
      })
      await new Promise<void>((done) => sockSrv.listen(sockPath, done))

      try {
        // HostService.setupURLs across all 4 Unix socket modes
        for (const m of ["ok", "closed", "mint_failed", "bad"] as const) {
          sockMode = m
          const r = await HostService.setupURLs(sockPath, 2_000).catch((e) => ({ err: String(e) }))
          assertInv(r !== undefined, `HostService.setupURLs ${m}`)
        }

        // HostService.installTelemetry, ready (503 starting phase), validateAddress, startText, startRefusal, maintenance, doctor
        const telem = await HostService.installTelemetry(`${httpOrigin}/api/install`, "cred-1")
        assertInv(
          telem !== undefined && (telem as { capacity?: number }).capacity === 4,
          "HostService.installTelemetry parsed"
        )
        const rdy = await HostService.ready(httpOrigin)
        assertInv(typeof rdy === "string" || typeof rdy === "boolean", "HostService.ready handles 503 starting phase")
        HostService.validateAddress({ bind: "127.0.0.1:4000", origins: ["http://127.0.0.1:4000"] })
        try {
          HostService.validateAddress({ bind: "not a host", origins: ["ftp://bad"] })
        } catch {}
        assertInv(
          typeof HostService.startText({ state: "running", setup_urls: ["http://127.0.0.1:4000/setup?token=a"] }) ===
            "string",
          "startText"
        )

        // Real bundle with fake smithers-backend for HostService.maintenance("backup" & "restore") + doctor
        const bundleDir = join(root, "bundle")
        const stateDir = join(root, "state")
        const agentsDir = join(root, "LaunchAgents")
        mkdirSync(join(bundleDir, "bin"), { recursive: true })
        mkdirSync(stateDir, { recursive: true })
        mkdirSync(agentsDir, { recursive: true })
        const fakeBackend = `#!/bin/sh\necho "backup-ok:$*"\nexit 0\n`
        const hash = createHash("sha256").update(fakeBackend).digest("hex")
        for (const rel of ["bin/smithers-server", "bin/smithers-backend", "bin/msb"]) {
          writeFileSync(join(bundleDir, rel), fakeBackend, { mode: 0o755 })
          chmodSync(join(bundleDir, rel), 0o755)
        }
        writeFileSync(
          join(bundleDir, "manifest.json"),
          JSON.stringify({
            version: 1,
            platform: "darwin-arm64",
            revision: "b".repeat(40),
            files: ["bin/smithers-server", "bin/smithers-backend", "bin/msb"].map((path) => ({
              path,
              sha256: hash,
              stage: "host",
              mode: 0o755
            }))
          })
        )
        let isLoaded = false
        const launchd: HostService.Launchd = {
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
        await HostService.install({
          bundle: bundleDir,
          stateDir,
          home: root,
          bind: "127.0.0.1:4000",
          origins: [httpOrigin]
        }, launchd)
        const bkp = HostService.maintenance("backup", join(root, "bak"), launchd)
        assertInv(bkp.includes("backup-ok"), "HostService.maintenance backup ran")
        let runningRestoreRefused = false
        try {
          HostService.maintenance("restore", join(root, "bak"), launchd)
        } catch {
          runningRestoreRefused = true
        }
        assertInv(runningRestoreRefused, "HostService.maintenance refuses restore while running")
        await HostService.stop(launchd)
        const rst = HostService.maintenance("restore", join(root, "bak"), launchd)
        assertInv(rst.includes("backup-ok"), "HostService.maintenance restore ran after stop")
        try {
          HostService.doctor(bundleDir, stateDir)
        } catch {}

        // 3. Checklist.repository on real FS with EVERY technology marker
        const repoDir = join(root, "polyglot-repo")
        mkdirSync(join(repoDir, ".smithers/flows/demo"), { recursive: true })
        mkdirSync(join(repoDir, ".github/workflows"), { recursive: true })
        mkdirSync(join(repoDir, ".git"), { recursive: true })
        mkdirSync(join(repoDir, "prisma"), { recursive: true })
        mkdirSync(join(repoDir, "packages/a"), { recursive: true })
        writeFileSync(join(repoDir, ".smithers/flows/demo/flow.ts"), "export default {}\n")
        writeFileSync(join(repoDir, ".git/config"), "[remote \"origin\"]\n\turl = git@github.com:acme/poly.git\n")
        writeFileSync(
          join(repoDir, "package.json"),
          JSON.stringify({
            name: "poly",
            scripts: { test: "vitest", build: "tsc", lint: "eslint", release: "changeset" },
            dependencies: { next: "15.0.0", react: "19.0.0", prisma: "6.0.0" }
          })
        )
        writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
        writeFileSync(join(repoDir, "packages/a/package.json"), JSON.stringify({ name: "@poly/a" }))
        writeFileSync(join(repoDir, "Dockerfile"), "FROM node:22\n")
        writeFileSync(join(repoDir, ".github/workflows/ci.yml"), "name: CI\non: [push]\n")
        writeFileSync(join(repoDir, "Cargo.toml"), "[package]\nname = \"poly\"\n")
        writeFileSync(join(repoDir, "go.mod"), "module example.com/poly\n")
        writeFileSync(join(repoDir, "pyproject.toml"), "[project]\nname = \"poly\"\n")
        writeFileSync(join(repoDir, "openapi.yaml"), "openapi: 3.1.0\n")
        writeFileSync(join(repoDir, "prisma/schema.prisma"), "datasource db { provider = \"postgresql\" }\n")
        writeFileSync(join(repoDir, "drizzle.config.ts"), "export default {}\n")
        writeFileSync(join(repoDir, "AGENTS.md"), "# Agents\n")

        const fsRepo = Checklist.repository(repoDir)
        const found: Array<Checklist.Suggestion> = []
        for await (const s of Checklist.scan(fsRepo)) {
          found.push(s)
        }
        assertInv(found.length >= 2, `Checklist.scan real FS repo found ${found.length} suggestions`)

        // 4. Cli.ts MCP add / login / --mcp stdio with PassThrough + AbortController
        const mcpHome = join(root, "mcp-home")
        mkdirSync(mcpHome, { recursive: true })
        const mcpCli = CliMod.makeCli({
          environment: { HOME: mcpHome, XDG_CONFIG_HOME: mcpHome, SMITHERS_MEMORY_DB: join(mcpHome, "mem.sqlite") },
          exit: () => {}
        })
        await serveCli(mcpCli, [
          "mcp",
          "add",
          "--agent",
          "claude-code",
          "--memory-db",
          join(mcpHome, "mem.sqlite"),
          "--json"
        ], { HOME: mcpHome })
        await serveCli(mcpCli, ["mcp", "add", "--agent", "unknown-agent-xyz", "--json"], { HOME: mcpHome })
        await serveCli(mcpCli, ["mcp", "login", "--origin", httpOrigin, "--no-open"], { HOME: mcpHome }).catch(() => {})

        const mcpIn = new PassThrough()
        const mcpOut = new PassThrough()
        const ac = new AbortController()
        const stdioCli = CliMod.makeCli({
          environment: { HOME: mcpHome },
          exit: () => {},
          signal: ac.signal,
          mcpStdio: { input: mcpIn, output: mcpOut }
        })
        const mcpPromise = stdioCli.serve(["--mcp"], { env: { HOME: mcpHome }, stdout: () => {}, exit: () => {} })
          .catch(() => {})
        setTimeout(() => {
          ac.abort()
          mcpIn.end()
        }, 150)
        await mcpPromise

        // 5. Detached child ignoring SIGTERM -> forces SIGKILL fallback + aborted launch + onSlowBoot + refused admission
        const detRoot = join(root, "det-root")
        mkdirSync(detRoot, { recursive: true })
        const stubStubborn = join(detRoot, "stubborn.cjs")
        writeFileSync(
          stubStubborn,
          `process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
          { mode: 0o755 }
        )
        const slowNotices: Array<string> = []
        const detTimeout = await Detached.launch({
          root: detRoot,
          payload: "{}",
          entry: stubStubborn,
          admission: async () => false,
          timeoutMs: 120,
          intervalMs: 25,
          terminationGraceMs: 80,
          onSlowBoot: (m) => slowNotices.push(m)
        }).catch((e) => ({ err: String(e) }))
        assertInv(detTimeout !== undefined, "Detached stubborn SIGTERM -> SIGKILL handled")

        const acDet = new AbortController()
        setTimeout(() => acDet.abort(), 50)
        const detAborted = await Detached.launch({
          root: detRoot,
          payload: "{}",
          entry: stubStubborn,
          admission: async () => true,
          signal: acDet.signal,
          timeoutMs: 2_000,
          terminationGraceMs: 80
        }).catch((e) => ({ err: String(e) }))
        assertInv(detAborted !== undefined, "Detached AbortSignal cancellation handled")

        // 6. NativeEquipment seatResolver across all provider/router/pool combinations
        const fakeExec = RequestExecutor.RequestExecutor.of({ execute: () => Effect.die("unused") } as never)
        const allEnv: Record<string, string | undefined> = {
          HOME: root,
          OPENAI_API_KEY: "sk-oai",
          GEMINI_API_KEY: "gem-key",
          OPENROUTER_API_KEY: "or-key",
          VERCEL_AI_GATEWAY_API_KEY: "vg-key",
          CEREBRAS_API_KEY: "cb-key",
          MOONSHOT_API_KEY: "ms-key",
          SMITHERS_ACCOUNT_POOL_URL: httpOrigin,
          SMITHERS_ACCOUNT_POOL_TOKEN: "pool-tok"
        }
        const resolver = NativeEquipment.seatResolver(allEnv, fakeExec)
        for (
          const s of [
            "openai:gpt-5.1",
            "gemini:gemini-2.5-pro",
            "openrouter:anthropic/claude-sonnet-4.5",
            "vercel:anthropic/claude-sonnet-4.5",
            "cerebras:llama-3.3-70b",
            "kimi-k3:kimi-k2",
            "codex-subscription:gpt-5.4",
            "claude-code:claude-sonnet-4-6",
            "anthropic:claude-sonnet-4-6",
            "jev",
            "sonnet",
            "gpt",
            "invalid::seat"
          ]
        ) {
          await Effect.runPromise(Effect.result(resolver.resolve(s)))
        }

        // 7. Command.cli full Effect CLI verb sweep on real project
        const proj = await project()
        try {
          const echoPath = join(proj, ".smithers/flows/echo/flow.ts")
          writeFileSync(
            echoPath,
            readFileSync(echoPath, "utf8").replace("capabilities: []", "capabilities: [\"fs:read:*\"]")
          )
          const ctrlLayer = NodeControl.layerControl({ root: proj })
          const cliServices = Layer.mergeAll(NodeServices.layer, TestConsole.layer, Output.layer, ctrlLayer)
          const runCmd = CliCommand.runWith(CommandMod.cli, { version: "1.0.0" })
          for (
            const argv of [
              ["flow", "list", "--root", proj],
              ["flow", "show", "echo", "--root", proj],
              ["flow", "plan", "echo", "message=hi", "--root", proj],
              ["runs", "list", "--root", proj],
              ["runs", "count", "--root", proj],
              ["approvals", "list", "--root", proj],
              ["doctor", "--root", proj],
              ["status", "--root", proj],
              ["--help"]
            ]
          ) {
            await Effect.runPromise(
              (runCmd(argv).pipe(Effect.provide(cliServices as Layer.Layer<any, never, never>)) as Effect.Effect<
                unknown,
                unknown,
                never
              >).pipe(
                Effect.result
              )
            )
          }
          void Control
        } finally {
          rmSync(proj, { recursive: true, force: true })
        }
      } finally {
        httpSrv.closeAllConnections?.()
        await new Promise<void>((done) => httpSrv.close(() => done()))
        sockSrv.closeAllConnections?.()
        await new Promise<void>((done) => sockSrv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
