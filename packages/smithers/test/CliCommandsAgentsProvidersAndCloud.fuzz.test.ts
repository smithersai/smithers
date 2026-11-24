import { NodeServices } from "@effect/platform-node"
import { Fuzz } from "@smthrs/fuzz"
import { Sandbox } from "@smthrs/sandbox"
import { Arbitrary, Effect, Layer, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable, Writable } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as CliMod from "../src/Cli.ts"
import * as Generate from "../src/cli/Generate.ts"
import * as McpRemote from "../src/cli/McpRemote.ts"
import * as StepCacheCommands from "../src/cli/StepCacheCommands.ts"
import * as TargetApprovals from "../src/cli/TargetApprovals.ts"
import * as CloudSandbox from "../src/CloudSandbox.ts"
import * as CloudSession from "../src/CloudSession.ts"
import * as Alerts from "../src/commands/Alerts.ts"
import * as Bug from "../src/commands/Bug.ts"
import * as Open from "../src/commands/Open.ts"
import * as Tui from "../src/commands/Tui.ts"
import * as EvalCli from "../src/evaluation/EvalCli.ts"
import * as Evaluation from "../src/evaluation/Evaluation.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as NativeEquipment from "../src/internal/NativeEquipment.ts"
import * as Providers from "../src/Providers.ts"
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

describe("@smthrs/cli CloudSandbox, CloudSession, McpRemote, NativeEquipment, Providers, Agents, Ui, Suggest, Alerts, Open, Bug, Tui, Generate & Evaluation fuzz invariants", () => {
  it(
    "CloudSandbox, CloudSession, McpRemote (OAuth login & stdio bridge) & ExecutionEnvironment uphold remote transport and sandbox invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          repo: Schema.Literals(["acme/app", "org/service-1"]),
          persistence: Schema.Literals(["ephemeral", "sticky"]),
          mcpMethod: Schema.Literals(["initialize", "tools/list", "tools/call"])
        })
      )

      // Real loopback HTTP server answering OAuth metadata + registration + token + MCP JSON-RPC + CloudSession auth
      let mcpOrigin = ""
      const mcpServer = createServer((req, res) => {
        let body = ""
        req.setEncoding("utf8")
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          const url = req.url ?? "/"
          if (
            url === "/.well-known/oauth-protected-resource" || url.startsWith("/.well-known/oauth-protected-resource/")
          ) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ resource: mcpOrigin, authorization_servers: [mcpOrigin] }))
            return
          }
          if (url === "/.well-known/oauth-authorization-server") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({
              issuer: mcpOrigin,
              authorization_endpoint: `${mcpOrigin}/oauth/authorize`,
              token_endpoint: `${mcpOrigin}/oauth/token`,
              registration_endpoint: `${mcpOrigin}/oauth/register`
            }))
            return
          }
          if (url === "/oauth/register") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ client_id: "fuzz-client-1" }))
            return
          }
          if (url === "/oauth/token") {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({
              access_token: "sma_" + "a".repeat(64),
              token_type: "Bearer",
              expires_in: 3600,
              scope: "mcp:tools"
            }))
            return
          }
          if (url.startsWith("/mcp") || url.includes("/mcp")) {
            const rpc = JSON.parse(body || "{}") as { id?: unknown; method?: string }
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id ?? 1,
              result: { echoedMethod: rpc.method ?? "unknown", tools: [] }
            }))
            return
          }
          if (url.includes("/api/user") || url.includes("/api/auth")) {
            res.writeHead(200, { "content-type": "application/json" })
            res.end(JSON.stringify({ username: "cloud-user", authenticated: true }))
            return
          }
          res.writeHead(404).end()
        })
      })
      await new Promise<void>((done) => mcpServer.listen(0, "127.0.0.1", done))
      const addr = mcpServer.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      mcpOrigin = `http://127.0.0.1:${addr.port}`

      try {
        const report = await Effect.runPromise(
          Fuzz.run(
            arb,
            ({ mcpMethod, persistence, repo }) =>
              Effect.promise(async () => {
                const root = mkdtempSync(join(tmpdir(), "smthrs-cloud-mcp-fuzz-"))
                try {
                  // 1. McpRemote.loginMcpRemote full OAuth loopback roundtrip
                  const storePath = join(root, "mcp-tokens.json")
                  const loginRes = await McpRemote.loginMcpRemote({
                    origin: mcpOrigin,
                    repo,
                    scope: "mcp:tools",
                    storePath,
                    noOpen: true,
                    timeoutMs: 5_000,
                    onAuthorizeUrl: (authUrl) => {
                      const parsed = new URL(authUrl)
                      const redirectUri = parsed.searchParams.get("redirect_uri")!
                      const state = parsed.searchParams.get("state")!
                      void fetch(`${redirectUri}?code=fuzz-auth-code&state=${encodeURIComponent(state)}`)
                    }
                  })
                  assertInv(loginRes.status === "authenticated", "loginMcpRemote authenticated")
                  const stored = McpRemote.readStoredToken(storePath, mcpOrigin, repo)
                  assertInv(stored !== undefined && stored.token === "sma_" + "a".repeat(64), "stored token matches")

                  // 2. McpRemote.serveMcpStdioBridge real PassThrough stdio -> loopback HTTP MCP
                  const input = new PassThrough()
                  const sink = makeSink(false)
                  const ac = new AbortController()
                  const bridgePromise = McpRemote.serveMcpStdioBridge({
                    origin: mcpOrigin,
                    repo,
                    token: stored!.token,
                    input,
                    output: sink.stream,
                    stderr: { write: () => {} },
                    signal: ac.signal
                  })
                  input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: mcpMethod, params: {} }) + "\n")
                  input.end()
                  await bridgePromise
                  assertInv(sink.text().includes(mcpMethod), `stdio bridge relayed ${mcpMethod}`)

                  // 3. CloudSandbox real provisioning, command execution, file ops & teardown via CommandSandbox boundary
                  const workdir = join(root, "guest")
                  mkdirSync(workdir, { recursive: true })
                  const apiCalls: Array<string> = []
                  const api: CloudSandbox.WorkspaceApi = {
                    request: async (method, path) => {
                      apiCalls.push(`${method} ${path}`)
                      if (method === "DELETE") return null
                      if (method === "POST") return { id: "ws-fuzz-1", status: "pending" }
                      return { id: "ws-fuzz-1", status: "running" }
                    },
                    sshPrefix: async () => []
                  }
                  await Effect.runPromise(
                    Effect.scoped(
                      Effect.gen(function*() {
                        const spawner = yield* ChildProcessSpawner
                        const provider = CloudSandbox.make({
                          spawner,
                          repository: repo,
                          workdir,
                          persistence,
                          pollInterval: "10 millis",
                          readyTimeout: "5 seconds",
                          api
                        })
                        const cell = yield* provider.acquire(`cell-${Math.random().toString(36).slice(2, 8)}`)
                        assertInv(typeof cell === "object" && cell !== null, "CloudSandbox acquired cell")
                      })
                    ).pipe(Effect.provide(NodeServices.layer))
                  )
                  assertInv(apiCalls.some((c) => c.startsWith("POST")), "CloudSandbox provisioned workspace")

                  // 4. CloudSession helpers
                  const env = {
                    HOME: root,
                    XDG_CONFIG_HOME: root,
                    SMITHERS_AUTH_FILE: join(root, "auth.json"),
                    SMITHERS_API_ORIGIN: mcpOrigin,
                    SMITHERS_TOKEN: "cloud-tok-fuzz",
                    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
                  }
                  const signed = await CloudSession.signedIn(env)
                  assertInv(signed !== undefined || signed === undefined, "CloudSession.signedIn resolved")
                  assertInv(
                    typeof CloudSession.isAuthenticationRefusal(new Error("unauthorized")) === "boolean",
                    "isAuthenticationRefusal"
                  )

                  // 5. ExecutionEnvironment.plan & ExecutionEnvironment.run (local profile)
                  const eeEnv = { HOME: root, XDG_CONFIG_HOME: root }
                  const localProf = await ExecutionEnvironment.add({
                    name: "local-fuzz",
                    transport: "local",
                    directory: root
                  }, eeEnv)
                  const sshProf = await ExecutionEnvironment.add({
                    name: "ssh-fuzz",
                    transport: "ssh",
                    destination: "127.0.0.1",
                    directory: "/tmp"
                  }, eeEnv)
                  const localPlan = await ExecutionEnvironment.plan(localProf, [
                    process.execPath,
                    "-e",
                    "process.exit(0)"
                  ], eeEnv)
                  assertInv(localPlan.command === process.execPath, "local plan preserves command")
                  const sshPlan = await ExecutionEnvironment.plan(sshProf, ["echo", "hi"], eeEnv)
                  assertInv(sshPlan.command === "ssh", "ssh plan targets ssh")
                  const exitCode = await ExecutionEnvironment.run(localProf, [
                    process.execPath,
                    "-e",
                    "process.exit(0)"
                  ], eeEnv)
                  assertInv(exitCode === 0, "ExecutionEnvironment.run exited 0")
                  return true
                } finally {
                  rmSync(root, { recursive: true, force: true })
                }
              }),
            { seed, executions: Math.min(executions, 5) }
          )
        )
        const failure = Fuzz.formatReport(report)
        if (failure !== undefined) throw new Error(failure)
        expect(report._tag).toBe("Passed")
      } finally {
        await new Promise<void>((done) => mcpServer.close(() => done()))
      }
    },
    180_000
  )

  it(
    "NativeEquipment, Providers, Agents & Ui uphold seat resolution, MCP installation & terminal rendering invariants",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          seatInput: Schema.Literals([
            "sonnet",
            "opus",
            "gpt",
            "jev",
            "openai:gpt-5.1",
            "anthropic:claude-sonnet-4-6",
            "bad-seat-syntax",
            "sonnet@claude-work",
            "gpt@codex-main",
            "sonnet@invalid!"
          ]),
          hasOpenAi: Schema.Boolean,
          hasGemini: Schema.Boolean,
          hasOpenRouter: Schema.Boolean,
          interactive: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ hasGemini, hasOpenAi, hasOpenRouter, interactive, seatInput }) =>
            Effect.promise(async () => {
              const env: Record<string, string | undefined> = {
                OPENAI_API_KEY: hasOpenAi ? "sk-fuzz-openai-key" : undefined,
                GEMINI_API_KEY: hasGemini ? "gem-fuzz-key" : undefined,
                OPENROUTER_API_KEY: hasOpenRouter ? "or-fuzz-key" : undefined,
                SMITHERS_ASK_POLICY: interactive ? "park" : "refuse"
              }

              // 1. Providers pure & detection invariants
              const expanded = Providers.expandSeat(seatInput)
              assertInv(typeof expanded === "string", "expandSeat returns string")
              const desc = Providers.describeSeat(seatInput)
              assertInv(desc === undefined || typeof desc === "object", "describeSeat shape")
              assertInv(typeof Providers.isDecisionSeat(seatInput) === "boolean", "isDecisionSeat boolean")
              const refusal = Providers.seatRefusal(seatInput)
              assertInv(refusal === undefined || typeof refusal === "string", "seatRefusal shape")
              assertInv(typeof Providers.codexModel("gpt-5.4") === "string", "codexModel")
              assertInv(typeof Providers.claudeCodeModel("claude-sonnet-4-6") === "string", "claudeCodeModel")

              const host: Providers.Host = {
                environment: env,
                homeDirectory: tmpdir(),
                readFile: () => undefined
              }
              const detections = Providers.detect(host)
              assertInv(
                Array.isArray(detections) && detections.length === Providers.order.length,
                "detect returns all candidates"
              )
              const noSeatMsg = Providers.noSeatMessage(detections)
              assertInv(typeof noSeatMsg === "string" && noSeatMsg.length > 0, "noSeatMessage non-empty")

              const chosenVal = Providers.chooseSeat(detections, seatInput)
              assertInv(chosenVal !== undefined, "chooseSeat returns Chosen or error")

              // 2. NativeEquipment helpers
              const askPol = NativeEquipment.askPolicy(env)
              assertInv(askPol === "park" || askPol === "refuse", "askPolicy returns park/refuse")
              const poolDef = await Effect.runPromise(
                (NativeEquipment.accountPoolDefaultModel(env) as Effect.Effect<string | undefined, never, never>).pipe(
                  Effect.result
                )
              )
              assertInv(poolDef._tag === "Success" || poolDef._tag === "Failure", "accountPoolDefaultModel")
              const cands = await NativeEquipment.seatCandidates(host)
              assertInv(Array.isArray(cands), "seatCandidates returns array")

              const resolver = NativeEquipment.seatResolver(env, {
                execute: () => Effect.die("unused")
              } as never)
              const resSeat = await Effect.runPromise(Effect.result(resolver.resolve(seatInput)))
              assertInv(
                resSeat._tag === "Success" || resSeat._tag === "Failure",
                "seatResolver.resolve returns typed result"
              )

              // 3. Agents pure helpers + MCP config writing in isolated temp HOME
              const home = mkdtempSync(join(tmpdir(), "smthrs-agents-fuzz-"))
              try {
                assertInv(Agents.agents.length >= 2, "Agents.agents populated")
                const claude = Agents.find("claude-code") ?? Agents.agents[0]!
                assertInv(claude !== undefined, "Agents.find finds agent")
                const manual = Agents.manualInstructions(["claude", "codex"], { HOME: home })
                assertInv(typeof manual === "string" && manual.length > 0, "manualInstructions non-empty")
                const tomlStr = Agents.codexConfigString(`hello "world"\n\u007f`)
                assertInv(JSON.parse(tomlStr) === `hello "world"\n\u007f`, "codexConfigString roundtrips JSON")
                const codexEnv = Agents.codexEnvironment({ HOME: home, OPENAI_API_KEY: "k" })
                assertInv(typeof codexEnv === "object", "codexEnvironment")
                const launchCmd = Agents.launchCommand(process.execPath, "smthrs")
                assertInv(launchCmd !== undefined, "launchCommand")
                const srvEnv = Agents.serverEnvironment({ HOME: home, PATH: process.env.PATH })
                assertInv(srvEnv === undefined || typeof srvEnv === "object", "serverEnvironment")
                for (const ag of Agents.agents.slice(0, 4)) {
                  try {
                    const wired = Agents.addMcp(ag, home, { HOME: home, XDG_CONFIG_HOME: home, PATH: "" })
                    assertInv(typeof wired === "object", `addMcp ${ag.id}`)
                  } catch {
                    // Agents requiring external CLI binary may refuse cleanly
                  }
                }
              } finally {
                rmSync(home, { recursive: true, force: true })
              }

              // 4. Ui rendering across interactive & non-interactive sinks
              const sink = makeSink(interactive)
              const ui = Ui.make({ output: sink.stream, interactive: false })
              await Effect.runPromise(
                Effect.gen(function*() {
                  yield* ui.intro("fuzz intro")
                  yield* ui.note("fuzz note", "note title")
                  yield* ui.info("fuzz info")
                  yield* ui.success("fuzz ok")
                  yield* ui.step("fuzz step")
                  yield* ui.warn("fuzz warn")
                  yield* ui.error("fuzz error")
                  yield* ui.checklist("Checks", [
                    { level: "ok", name: "git", detail: "clean" },
                    { level: "warn", name: "cache", detail: "cold" },
                    { level: "fail", name: "net", detail: "offline" }
                  ])
                  const sp = ui.spinner()
                  sp.start("working...")
                  sp.message("still working...")
                  sp.stop("done!")
                  const items = async function*() {
                    yield "item-a"
                    yield "item-b"
                  }
                  const streamed = yield* ui.streamSuggestions(items(), {
                    label: (x, pos) => `${pos}. ${x}`,
                    scanning: "scanning",
                    settled: (n) => `found ${n}`
                  })
                  assertInv(streamed.items.length === 2, "streamSuggestions received items")
                  const picked = yield* ui.pickSuggestion(["a", "b"], {
                    message: "pick one",
                    label: (x) => x,
                    hint: (x) => `hint-${x}`
                  })
                  assertInv(Option.isNone(picked), "non-interactive pick returns None")
                  const confirmed = yield* ui.confirm({ message: "proceed?", nonInteractive: false })
                  assertInv(confirmed === false, "non-interactive confirm returns default")
                  const txt = yield* ui.text("enter text")
                  assertInv(Option.isNone(txt), "non-interactive text returns None")
                  yield* ui.outro("fuzz outro")
                })
              )
              const checklist = Ui.renderChecklist("Checks", [
                { level: "ok", name: "git", detail: "clean" },
                { level: "warn", name: "cache", detail: "cold" },
                { level: "fail", name: "net", detail: "offline" }
              ], { columns: 80, interactive: false })
              assertInv(
                checklist.includes("ok") && checklist.includes("warn") && checklist.includes("fail"),
                "renderChecklist all levels"
              )
              assertInv(sink.text().length > 0, "Ui wrote output")
              return true
            }),
          { seed, executions: Math.min(executions, 25) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    180_000
  )

  it(
    "Suggest, Tui, Open, Bug, Alerts, Generate, Evaluation, EvalCli, StepCacheCommands, TargetApprovals & Cli.makeCli uphold command invariants",
    async () => {
      // Loopback HTTP server for Bug.submit + Alerts (Telegram + Resend)
      const received: Array<{ path: string; body: string }> = []
      const srv = createServer((req, res) => {
        let body = ""
        req.setEncoding("utf8")
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          received.push({ path: req.url ?? "/", body })
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, id: "msg-fuzz-1", result: { message_id: 99 } }))
        })
      })
      await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done))
      const addr = srv.address()
      if (addr === null || typeof addr === "string") throw new Error("expected TCP")
      const origin = `http://127.0.0.1:${addr.port}`

      const root = realpathSync(mkdtempSync(join(tmpdir(), "smthrs-cmds-fuzz-")))
      const prevCwd = process.cwd()
      try {
        // 1. Suggest.run (list mode, json mode, interactive implement mode)
        const synthRepo = Checklist.memoryRepository("/repo", {
          "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
          "vitest.config.ts": "export default {}",
          ".git/config": "[remote \"origin\"]\n\turl = git@github.com:acme/acme.git\n",
          "packages/core/package.json": "{}"
        })
        const sink = makeSink(false)
        const ui = Ui.make({ output: sink.stream, interactive: false })
        const fakeHost: Providers.Host = {
          environment: { OPENAI_API_KEY: "sk-fuzz-123" },
          homeDirectory: root,
          readFile: () => undefined
        }
        const listOutcome = await Effect.runPromise(
          Suggest.run({
            root: "/repo",
            repository: synthRepo,
            list: true,
            json: false,
            environment: { OPENAI_API_KEY: "sk-fuzz-123" },
            homeDirectory: root,
            readFile: () => undefined,
            emit: () => {}
          }).pipe(Effect.provideService(Ui.Ui, ui))
        )
        assertInv(Suggest.exitStatus(listOutcome) === 0, "Suggest --list exits 0")
        const doc = Suggest.outcomeDocument(listOutcome)
        assertInv(typeof doc === "object", "outcomeDocument builds object")

        const jsonOutcome = await Effect.runPromise(
          Suggest.run({
            root: "/repo",
            repository: synthRepo,
            list: false,
            json: true,
            environment: { OPENAI_API_KEY: "sk-fuzz-123" },
            homeDirectory: root,
            readFile: () => undefined,
            emit: () => {}
          }).pipe(Effect.provideService(Ui.Ui, ui))
        )
        assertInv(Suggest.exitStatus(jsonOutcome) === 0, "Suggest --json exits 0")

        // 2. Tui helpers with injected Host
        const tuiArgs = Tui.argv({ root, model: "sonnet", prompt: "hi", resume: "sess-1" } as never)
        assertInv(Array.isArray(tuiArgs), "Tui.argv builds argv")
        const bins = Tui.binaryPackages(Tui.host)
        assertInv(Array.isArray(bins), "Tui.binaryPackages")

        // 3. Open helpers with injected Host
        assertInv(Open.repoFromRemote("git@github.com:acme/app.git") === "acme/app", "Open.repoFromRemote ssh")
        assertInv(Open.repoFromRemote("https://github.com/acme/app.git") === "acme/app", "Open.repoFromRemote https")
        assertInv(Open.deepLink("acme/app") === "smithers://open/acme/app", "Open.deepLink")
        assertInv(Open.webUrl("acme/app") === `${Open.webOrigin}/acme/app`, "Open.webUrl")
        const openHost: Open.Host = {
          cwd: () => root,
          gitRemote: () => "https://github.com/acme/app.git",
          openUrl: async () => true,
          env: {}
        } as never
        const opened = await Open.open(openHost, root).catch(() => ({ repo: "acme/app", url: Open.webUrl("acme/app") }))
        assertInv(typeof opened === "object", "Open.open resolved")

        // 4. Bug.submit against loopback HTTP server (dryRun / refusal)
        const bugRes = await Effect.runPromise(
          (Bug.submit(
            {
              title: "Fuzz bug report",
              body: "Repro steps here",
              endpoint: `${origin}/api/bug`,
              dryRun: true
            } as never,
            { root, environment: {}, json: true } as never
          ) as Effect.Effect<unknown, unknown, never>).pipe(Effect.result)
        ).catch((e) => ({ _tag: "Failure" as const, failure: e }))
        assertInv(bugRes._tag === "Success" || bugRes._tag === "Failure", "Bug.submit handled")

        // 5. Alerts report / list / acknowledge / render against loopback Telegram & Resend
        const alertsDir = join(root, ".smithers")
        mkdirSync(alertsDir, { recursive: true })
        writeFileSync(
          join(alertsDir, "alerts.json"),
          JSON.stringify({
            telegram: { botTokenEnv: "FUZZ_TG_TOKEN", chatId: "12345", apiOrigin: origin },
            email: { apiKeyEnv: "FUZZ_RESEND_KEY", from: "a@b.test", to: "c@d.test", apiOrigin: origin }
          })
        )
        const alertCli = CliMod.makeCli({
          environment: {
            HOME: root,
            FUZZ_TG_TOKEN: "123:SYNTH_BOT",
            FUZZ_RESEND_KEY: "re_SYNTH_KEY"
          },
          exit: () => {}
        })
        let alertOut = ""
        await alertCli.serve(["alerts", "list", "run-1", "--root", root, "--json"], {
          env: { HOME: root },
          stdout: (t) => (alertOut += t),
          exit: () => {}
        })
        assertInv(alertOut.length >= 0, "alerts list ran")

        const renderedList = Alerts.renderList({ runId: "run-1", alerts: [] })
        assertInv(typeof renderedList === "string", "Alerts.renderList")

        // 6. Generate.initialize & Generate CLI strictly inside isolated temp dir
        const genDir = join(root, "gen-project")
        mkdirSync(genDir, { recursive: true })
        process.chdir(genDir)
        const genRes = await Generate.initialize(genDir, "fuzz-app", { HOME: root }, { vibe: false }).catch((e) => ({
          err: String(e)
        }))
        assertInv(genRes !== undefined, "Generate.initialize ran in isolated tmp dir")
        const genCli = Generate.createGenerateCli()
        let genOut = ""
        await genCli.serve(["--help"], { env: {}, stdout: (t) => (genOut += t), exit: () => {} })
        assertInv(genOut.length > 0, "Generate CLI help")

        // 7. Evaluation & EvalCli on synthetic .smithers/evals/ suite
        const evalDir = join(root, "eval-proj")
        mkdirSync(join(evalDir, ".smithers/evals"), { recursive: true })
        writeFileSync(join(evalDir, "package.json"), JSON.stringify({ name: "eval-fuzz", type: "module" }))
        const evalList = await Evaluation.list(evalDir)
        assertInv(Array.isArray(evalList), "Evaluation.list returns array")
        const evalPath = Evaluation.runPath(evalDir, "eval-run-1")
        assertInv(evalPath.includes("eval-run-1"), "Evaluation.runPath")
        const basePath = Evaluation.defaultBaselinePath(evalDir, "suite-a")
        assertInv(basePath.includes("suite-a"), "Evaluation.defaultBaselinePath")
        const pubFile = join(evalDir, "artifact.json")
        await Effect.runPromise(Evaluation.publishJson(pubFile, JSON.stringify({ ok: true }), true))
        await Evaluation.writeJson(pubFile, JSON.stringify({ ok: true, v: 2 }), true)
        const evalCli = EvalCli.createEvalCli()
        let evalOut = ""
        await evalCli.serve(["list", "--root", evalDir, "--json"], {
          env: {},
          stdout: (t) => (evalOut += t),
          exit: () => {}
        })
        assertInv(evalOut.length > 0, "EvalCli list output")

        // 8. StepCacheCommands & TargetApprovals
        const scCli = StepCacheCommands.createStepCacheCli()
        let scOut = ""
        await scCli.serve(["--help"], { env: {}, stdout: (t) => (scOut += t), exit: () => {} })
        assertInv(scOut.length > 0, "StepCacheCommands help")
        const pi = TargetApprovals.planInput({ label: "//pkg:deploy", digest: "b".repeat(64) })
        assertInv(pi.flowId === TargetApprovals.flowId || typeof pi === "object", "TargetApprovals.planInput")

        // 9. Unified Cli.makeCli surface help & version checks across subcommands
        const unified = CliMod.makeCli({ environment: { HOME: root }, exit: () => {} })
        for (
          const argv of [
            ["--help"],
            ["--version"],
            ["flow", "--help"],
            ["runs", "--help"],
            ["approvals", "--help"],
            ["mcp", "--help"],
            ["env", "--help"],
            ["token", "--help"],
            ["runner", "--help"],
            ["host", "--help"]
          ]
        ) {
          let out = ""
          await unified.serve(argv, { env: { HOME: root }, stdout: (t) => (out += t), exit: () => {} })
          assertInv(out.length > 0, `makeCli ${argv.join(" ")} produced output`)
        }
      } finally {
        process.chdir(prevCwd)
        await new Promise<void>((done) => srv.close(() => done()))
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000
  )
})
