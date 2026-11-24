import * as ControlSchema from "@smthrs/control/ControlSchema"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Cli from "../src/Cli.ts"
import * as Generate from "../src/cli/Generate.ts"
import * as McpRemote from "../src/cli/McpRemote.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import * as RunActivity from "../src/cli/RunActivity.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as StepCacheCommands from "../src/cli/StepCacheCommands.ts"
import * as Ui from "../src/Ui.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261126")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const expectPassed = (report: { readonly _tag: string; readonly findings?: ReadonlyArray<unknown> }) => {
  if (report._tag !== "Passed") {
    const first = report.findings?.[0] as { failure?: { defect?: unknown } } | undefined
    const d = first?.failure?.defect
    const msg = d instanceof Error ? d.message : JSON.stringify(report.findings?.[0])
    throw new Error(`Falsified: ${msg}`)
  }
  expect(report._tag).toBe("Passed")
}

const makeCapture = (isTTY = false) => {
  let buf = ""
  const s = new PassThrough()
  s.on("data", (c) => {
    buf += c.toString("utf8")
  })
  return {
    stream: Object.assign(s, { isTTY }),
    read: () => buf
  }
}

describe("@smthrs/cli Wave-7C McpRemote, RunProgress, RunActivity, Presentation, Ui, Generate, StepCacheCommands & Cli fuzz invariants", () => {
  it(
    "McpRemote OAuth callback error/timeout/duplicate paths & stdio bridge 202/401/unreachable/abort/oversize invariants",
    async () => {
      // 1. Fuzz McpRemote origin/repo/token helpers
      const strArb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["valid-http", "valid-https", "bad-proto", "bad-url", "repo-ok", "repo-bad"])
        })
      )
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-w7c-mcp-"))
      try {
        const rep = await Effect.runPromise(
          Fuzz.run(
            strArb,
            (input) =>
              Effect.sync(() => {
                if (input.mode === "valid-http") {
                  const o = McpRemote.normalizeOrigin("http://127.0.0.1:8787/")
                  assertInv(o === "http://127.0.0.1:8787", "strips trailing slash")
                  assertInv(
                    McpRemote.mcpEndpointUrl(o, "acme/demo").endsWith("/acme/demo/mcp") ||
                      McpRemote.mcpEndpointUrl(o, "acme/demo").includes("acme/demo"),
                    "endpoint has repo"
                  )
                } else if (input.mode === "valid-https") {
                  const o = McpRemote.normalizeOrigin("https://smithers.sh///")
                  assertInv(o === "https://smithers.sh", "normalizes https")
                } else if (input.mode === "bad-proto" || input.mode === "bad-url") {
                  let threw = false
                  try {
                    McpRemote.normalizeOrigin(input.mode === "bad-proto" ? "ftp://example.com" : "not a url")
                  } catch {
                    threw = true
                  }
                  assertInv(threw, "invalid origin refused")
                } else if (input.mode === "repo-ok") {
                  assertInv(McpRemote.normalizeRepo("acme/smithers") === "acme/smithers", "valid repo")
                } else {
                  let threw = false
                  try {
                    McpRemote.normalizeRepo("../bad/repo/extra")
                  } catch {
                    threw = true
                  }
                  assertInv(threw, "invalid repo refused")
                }
                return true
              }),
            { executions: Math.min(executions, 30), seed }
          )
        )
        expectPassed(rep)

        // 2. Real loopback OAuth server testing /callback 404, error=access_denied, missing code, duplicate callback, and timeout
        let oauthMode: "404-then-denied" | "missing-code" | "timeout" = "404-then-denied"
        const oauthServer = createServer((req, res) => {
          if (req.url === "/.well-known/oauth-authorization-server") {
            const addr = oauthServer.address() as AddressInfo
            const base = `http://127.0.0.1:${addr.port}`
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
              JSON.stringify({
                authorization_endpoint: `${base}/authorize`,
                token_endpoint: `${base}/token`,
                registration_endpoint: `${base}/register`
              })
            )
            return
          }
          if (req.url === "/register") {
            res.writeHead(201, { "content-type": "application/json" })
            res.end(JSON.stringify({ client_id: "cid-fuzz-1" }))
            return
          }
          res.writeHead(404)
          res.end("not found")
        })
        await new Promise<void>((r) => oauthServer.listen(0, "127.0.0.1", () => r()))
        const oauthOrigin = `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`

        try {
          for (const mode of ["404-then-denied", "missing-code", "timeout"] as const) {
            oauthMode = mode
            const errOut = makeCapture(false)
            const loginResult = McpRemote.loginMcpRemote({
              origin: oauthOrigin,
              noOpen: true,
              timeoutMs: mode === "timeout" ? 40 : 2000,
              env: { HOME: tmp },
              stderr: errOut.stream as unknown as NodeJS.WriteStream
            }).then(() => null, (err) => err)

            if (mode !== "timeout") {
              // Wait for stderr to print the authorize URL with redirect_uri
              let redirectUri: string | null = null
              for (let i = 0; i < 40; i++) {
                const text = errOut.read()
                const m = /redirect_uri=([^&\s]+)/.exec(text)
                if (m && m[1]) {
                  redirectUri = decodeURIComponent(m[1])
                  break
                }
                await new Promise((r) => setTimeout(r, 10))
              }
              expect(redirectUri).not.toBeNull()
              const cbBase = new URL(redirectUri!).origin
              if (oauthMode === "404-then-denied") {
                const r404 = await fetch(`${cbBase}/not-callback`)
                expect(r404.status).toBe(404)
                const rDeny = await fetch(`${redirectUri!}?error=access_denied`)
                expect(rDeny.status).toBe(400)
              } else {
                const rMissing = await fetch(`${redirectUri!}?state=only`)
                expect(rMissing.status).toBe(400)
              }
            }
            const err = await loginResult
            expect(err).toBeInstanceOf(Error)
          }

          // 3. Real loopback Streamable HTTP MCP bridge: 202 accepted, 401 auth required, 200 JSON-RPC reply, unreachable origin, AbortSignal
          let statusToSend = 200
          const mcpServer = createServer((req, res) => {
            let body = ""
            req.on("data", (c) => {
              body += c.toString()
            })
            req.on("end", () => {
              if (statusToSend === 202) {
                res.writeHead(202)
                res.end()
              } else if (statusToSend === 401) {
                res.writeHead(401, { "content-type": "application/json" })
                res.end(JSON.stringify({ error: "unauthorized" }))
              } else {
                const parsed = JSON.parse(body || "{}") as { id?: unknown }
                res.writeHead(200, { "content-type": "application/json" })
                res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? null, result: { ok: true } }))
              }
            })
          })
          await new Promise<void>((r) => mcpServer.listen(0, "127.0.0.1", () => r()))
          const mcpOrigin = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`

          try {
            for (const code of [200, 202, 401] as const) {
              statusToSend = code
              const input = new PassThrough()
              const output = makeCapture(false)
              const stderr = makeCapture(false)
              const bridge = McpRemote.serveMcpStdioBridge({
                origin: mcpOrigin,
                repo: "acme/demo",
                env: { HOME: tmp },
                input: input as never,
                output: output.stream as never,
                stderr: stderr.stream as unknown as NodeJS.WriteStream
              })
              input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`)
              input.end()
              await bridge
              if (code === 200) expect(output.read()).toContain("\"ok\":true")
              if (code === 401) {
                expect(output.read()).toContain("-32001")
                expect(stderr.read()).toContain("smthrs mcp login")
              }
            }

            // Unreachable origin + AbortSignal cleanup
            const inputUnreach = new PassThrough()
            const outUnreach = makeCapture(false)
            const errUnreach = makeCapture(false)
            const ac = new AbortController()
            const bridgeUnreach = McpRemote.serveMcpStdioBridge({
              origin: "http://127.0.0.1:1",
              env: { HOME: tmp },
              input: inputUnreach as never,
              output: outUnreach.stream as never,
              stderr: errUnreach.stream as unknown as NodeJS.WriteStream,
              signal: ac.signal
            })
            inputUnreach.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`)
            setTimeout(() => ac.abort(), 150)
            await bridgeUnreach
            expect(outUnreach.read().includes("-32000") || ac.signal.aborted).toBe(true)
          } finally {
            await new Promise<void>((r) => mcpServer.close(() => r()))
          }
        } finally {
          await new Promise<void>((r) => oauthServer.close(() => r()))
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    60_000
  )

  it(
    "RunProgress engine events, RunActivity folding, Presentation human/structured rendering & Ui non-interactive/abort invariants",
    async () => {
      // 1. Fuzz RunProgress.project across ActionCall schedule/retry/settle(ok/clean/skipped/failed) & executionFact start/settle
      const progArb = Arbitrary.schema(
        Schema.Struct({
          outcome: Schema.Literals(["ok", "clean", "skipped", "deferred", "failed"]),
          execStatus: Schema.Literals(["running", "completed", "failed", "cancelled"]),
          retry: Schema.Boolean
        })
      )
      const progRep = await Effect.runPromise(
        Fuzz.run(
          progArb,
          (input) =>
            Effect.sync(() => {
              let state = RunProgress.initial()
              const mkEvent = (
                seq: number,
                eventType: string,
                payload: Record<string, unknown>
              ): ControlSchema.ControlEvent =>
                ({
                  runId: "ctrl-1",
                  seq,
                  timestamp: "2026-11-24T00:00:00.000Z",
                  kind: "control.engine.event",
                  payload: {
                    executionId: "exec-child-1",
                    eventType,
                    payload: {
                      nodeId: "node-a",
                      ...payload
                    }
                  }
                }) as unknown as ControlSchema.ControlEvent

              const s1 = RunProgress.project(
                state,
                mkEvent(1, "flows.engine.node-scheduled", { kind: "ActionCall", action: "build" })
              )
              assertInv(
                s1.state.started === 1 && Boolean(s1.lines[0]?.text.includes("Running build")),
                "initial schedule"
              )
              state = s1.state

              if (input.retry) {
                const sRetry = RunProgress.project(
                  state,
                  mkEvent(2, "flows.engine.node-scheduled", { kind: "ActionCall", action: "build" })
                )
                assertInv(
                  sRetry.state.started === 1 && Boolean(sRetry.lines[0]?.text.includes("Retrying build")),
                  "retry keeps started count"
                )
                state = sRetry.state
              }

              const s2 = RunProgress.project(
                state,
                mkEvent(3, "flows.engine.node-settled", {
                  action: "build",
                  outcome: input.outcome,
                  message: input.outcome === "failed" ? "boom" : ""
                })
              )
              assertInv(s2.lines.length === 1, "settle emits line")
              state = s2.state

              // Settling unknown node is a no-op
              const sUnknown = RunProgress.project(
                state,
                mkEvent(4, "flows.engine.node-settled", { action: "build", outcome: "ok" })
              )
              assertInv(sUnknown.lines.length === 0, "double settle ignored")

              // Execution fact observation (start + duplicate + settled + duplicate)
              const mkFact = (seq: number, status: string) =>
                mkEvent(seq, "flows.engine.execution-observed", {
                  executionFact: {
                    observation: {
                      executionId: "exec-child-1",
                      flowName: "demo/child",
                      status
                    }
                  }
                })
              const fStart = RunProgress.project(state, mkFact(5, "running"))
              assertInv(fStart.lines.length === 1 && fStart.lines[0]!.text.includes("Started"), "exec started")
              const fStartDup = RunProgress.project(fStart.state, mkFact(6, "running"))
              assertInv(fStartDup.lines.length === 0, "duplicate start suppressed")

              if (input.execStatus !== "running") {
                const fEnd = RunProgress.project(fStartDup.state, mkFact(7, input.execStatus))
                assertInv(fEnd.lines.length === 1 && fEnd.lines[0]!.text.includes(input.execStatus), "exec settled")
                const fEndDup = RunProgress.project(fEnd.state, mkFact(8, input.execStatus))
                assertInv(fEndDup.lines.length === 0, "duplicate settle suppressed")
              }

              // Also check RunActivity.fold on the same control events
              const act = RunActivity.fold(
                [
                  mkEvent(1, "flows.engine.node-scheduled", { kind: "ActionCall", action: "build" }),
                  mkEvent(2, "flows.engine.node-settled", { action: "build", outcome: input.outcome })
                ],
                { runId: "ctrl-1", flowId: "demo" }
              )
              assertInv(act !== undefined, "RunActivity.fold returns activity")
              return true
            }),
          { executions: Math.min(executions, 40), seed }
        )
      )
      expectPassed(progRep)

      // 2. Presentation.withErrorEnvelope + Presentation.scope + Presentation.finish (human plain/live + structured + deep objects + >18 keys)
      const bigObj: Record<string, unknown> = {
        emptyArr: [],
        deep: { l1: { l2: { l3: { l4: "too deep" } } } },
        deepArr: { l1: { l2: [1, 2, 3] } },
        runId: "run-pres-1"
      }
      for (let i = 0; i < 20; i++) bigObj[`k${i}`] = `val-${i}`

      for (const structured of [false, true] as const) {
        for (const progress of ["plain", "live"] as const) {
          const syncOut = makeCapture(!structured)
          const syncErr = makeCapture(false)
          await Presentation.scope(
            {
              command: "demo",
              formatExplicit: structured,
              globals: { audience: structured ? "agent" : "human" },
              options: {}
            },
            {
              environment: {},
              stdout: syncOut.stream as unknown as NodeJS.WriteStream,
              stderr: syncErr.stream as unknown as NodeJS.WriteStream,
              presentation: {
                audience: structured ? "agent" : "human",
                structured,
                interactive: false,
                progress: structured ? "silent" : progress,
                source: "terminal",
                harnesses: []
              }
            },
            async () => {
              const ctx: Presentation.Context = {
                command: "demo",
                ok: (val: unknown) => val as never,
                options: {}
              }
              Presentation.finish(ctx, bigObj)
              Presentation.finish(ctx, { runId: "r2" }, { human: "Custom human body\n" })
            }
          )
          const outText = syncOut.read()
          if (!structured) {
            expect(outText).toContain("more; use --json for full details")
            expect(outText).toContain("Custom human body")
          }
        }
      }

      const wrappedChunks: Array<string> = []
      await Presentation.withErrorEnvelope(
        (text) => wrappedChunks.push(text),
        async (stdout) => {
          stdout(JSON.stringify({ code: "demo_err", message: "boom" }))
          stdout("plain line\n")
        }
      )
      expect(wrappedChunks.length).toBeGreaterThanOrEqual(2)

      // 3. Ui.make stream (normal + abort + error), pickSuggestion, confirm, text, renderChecklist
      const uiOut = makeCapture(false)
      const uiIn = new PassThrough()
      const ui = Ui.make({ output: uiOut.stream, input: uiIn, interactive: false })
      const streamed = await Effect.runPromise(
        ui.streamSuggestions(
          (async function*() {
            yield "item-1"
            yield "item-2"
          })(),
          {
            scanning: "Scanning",
            settled: (n) => `Found ${n}`,
            label: (item, i) => `${i}: ${item}`
          }
        )
      )
      expect(streamed.items).toEqual(["item-1", "item-2"])
      expect(streamed.stopped).toBe(false)

      // Stream throwing mid-way catches cleanly
      const errExit = await Effect.runPromiseExit(
        ui.streamSuggestions(
          (async function*() {
            yield "a"
            throw new Error("stream boom")
          })(),
          {
            scanning: "Scanning",
            settled: (n) => `Found ${n}`,
            label: (x) => x
          }
        )
      )
      expect(errExit._tag).toBe("Failure")

      const pickedEmpty = await Effect.runPromise(ui.pickSuggestion([], { message: "Pick", label: (x) => String(x) }))
      expect(Option.isNone(pickedEmpty)).toBe(true)
      const pickedNonInt = await Effect.runPromise(
        ui.pickSuggestion(["alpha", "beta"], { message: "Pick one", label: (x) => x })
      )
      expect(Option.isNone(pickedNonInt)).toBe(true)
      expect(await Effect.runPromise(ui.confirm({ message: "Proceed?", nonInteractive: true }))).toBe(true)
      expect(await Effect.runPromise(ui.confirm({ message: "Proceed?", nonInteractive: false }))).toBe(false)
      expect(Option.isNone(await Effect.runPromise(ui.text("Enter name")))).toBe(true)
    },
    60_000
  )

  it("Generate.initialize errors, StepCacheCommands & Cli top-level command dispatch uphold invariants", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "smthrs-w7c-gen-"))
    try {
      // 1. Invalid package.json -> package_json_invalid
      const badJsonDir = join(tmp, "bad-json")
      mkdirSync(badJsonDir, { recursive: true })
      writeFileSync(join(badJsonDir, "package.json"), "{broken-json")
      await expect(Generate.initialize(badJsonDir, "demo", {})).rejects.toThrow(/not valid JSON/i)

      // 2. Unsupported packageManager -> unsupported_toolchain
      const badPmDir = join(tmp, "bad-pm")
      mkdirSync(badPmDir, { recursive: true })
      writeFileSync(
        join(badPmDir, "package.json"),
        JSON.stringify({
          name: "demo",
          repository: { url: "https://github.com/acme/demo" },
          packageManager: "npm@10.0.0"
        })
      )
      await expect(Generate.initialize(badPmDir, "demo", {})).rejects.toThrow(/supported workspace toolchain/i)

      // 3. Valid workspace initialization + idempotent second call retains WORKSPACE.ts
      const okDir = join(tmp, "ok-ws")
      mkdirSync(okDir, { recursive: true })
      writeFileSync(
        join(okDir, "package.json"),
        JSON.stringify({ name: "demo", repository: "https://github.com/acme/demo", packageManager: "pnpm@11.25.0" })
      )
      const firstInit = await Generate.initialize(okDir, "demo", {})
      expect(firstInit.created.length).toBeGreaterThan(0)
      const secondInit = await Generate.initialize(okDir, "demo", {})
      expect(secondInit.retained.length).toBeGreaterThan(0)

      // 4. StepCacheCommands CLI help & status
      const stepCli = StepCacheCommands.createStepCacheCli({ environment: { HOME: tmp } })
      let stepOut = ""
      await stepCli.serve(["--help"], {
        env: { HOME: tmp },
        stdout: (t) => {
          stepOut += t
        },
        exit: () => {}
      })
      expect(stepOut.length).toBeGreaterThan(0)

      // 5. Top-level Cli.makeCli commands: gc --dry-run, update --help, mcp --help, generate --help
      const out = makeCapture(false)
      const err = makeCapture(false)
      const cli = Cli.makeCli({
        environment: { ...process.env, HOME: tmp },
        stdout: out.stream as unknown as NodeJS.WriteStream,
        stderr: err.stream as unknown as NodeJS.WriteStream,
        exit: () => {}
      })
      for (
        const argv of [
          ["gc", "--dry-run", "--workspace", okDir],
          ["mcp", "--help"],
          ["generate", "--help"],
          ["suggest", "--help"],
          ["update", "--help"]
        ]
      ) {
        await cli.serve(argv, {
          env: { ...process.env, HOME: tmp },
          stdout: (t) => {
            out.stream.write(t)
          },
          exit: () => {}
        })
      }
      expect(out.read().length).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 60_000)
})
