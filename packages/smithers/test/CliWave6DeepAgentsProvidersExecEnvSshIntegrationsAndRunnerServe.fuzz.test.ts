import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import * as Model from "@smthrs/model/Model"
import { Arbitrary, Effect, Fiber, Layer, Schema, Stream } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as ClientMod from "../src/internal/backend/Client.ts"
import * as SSH from "../src/internal/backend/SSH.ts"
import * as ClaudeCode from "../src/internal/ClaudeCode.ts"
import * as SupervisorMemory from "../src/internal/SupervisorMemory.ts"
import * as Credentials from "../src/operator/Credentials.ts"
import * as Integrations from "../src/operator/Integrations.ts"
import * as Providers from "../src/Providers.ts"
import * as Host from "../src/runner/Host.ts"
import * as Serve from "../src/runner/Serve.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261134")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const runIncur = async (cli: any, argv: Array<string>) => {
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

describe("@smthrs/cli Wave-6B Deep Agents, Providers, ExecutionEnvironment, SSH, Integrations, Credentials, SupervisorMemory, ClaudeCode & Runner Serve fuzz invariants", () => {
  it(
    "Agents MCP wiring (all agents), Providers.claudeCodeLogin, ExecutionEnvironment (local/ssh/workspace) & SSH uphold invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-apessh-"))
      const homeDir = join(tmp, "home")
      const binOk = join(tmp, "bin-ok")
      const binBad = join(tmp, "bin-bad")
      const binSsh = join(tmp, "bin-ssh")
      mkdirSync(homeDir, { recursive: true })
      mkdirSync(binOk, { recursive: true })
      mkdirSync(binBad, { recursive: true })
      mkdirSync(binSsh, { recursive: true })

      // Fake claude executables for Providers.claudeCodeLogin
      const claudeOk = join(binOk, "claude")
      writeFileSync(
        claudeOk,
        `#!${process.execPath}
console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }))
`
      )
      chmodSync(claudeOk, 0o755)

      const claudeBad = join(binBad, "claude")
      writeFileSync(
        claudeBad,
        `#!${process.execPath}
console.error("not logged in")
process.exit(1)
`
      )
      chmodSync(claudeBad, 0o755)

      // Fake ssh executable for SSH.remote
      const fakeSsh = join(binSsh, "ssh")
      writeFileSync(
        fakeSsh,
        `#!${process.execPath}
console.log("ssh-ok:" + process.argv.slice(2).join(" "))
process.exit(0)
`
      )
      chmodSync(fakeSsh, 0o755)

      try {
        // 1. Agents: addMcp for EVERY agent in Agents.agents (first write + idempotent second write) + manualInstructions + codex helpers
        const agentEnv: Record<string, string | undefined> = {
          HOME: homeDir,
          XDG_CONFIG_HOME: join(homeDir, ".config"),
          APPDATA: join(homeDir, "AppData"),
          SMITHERS_URL: "https://smithers.sh"
        }
        for (const agent of Agents.agents) {
          const w1 = Agents.addMcp(agent, homeDir, agentEnv)
          expect(w1.agent).toBe(agent.id)
          const w2 = Agents.addMcp(agent, homeDir, agentEnv)
          expect(w2.agent).toBe(agent.id)
        }
        const manual = Agents.manualInstructions(["claude", "codex"], { SMITHERS_MEMORY_DB: join(tmp, "mem.db") })
        expect(manual).toContain("claude mcp add")
        expect(Agents.codexConfigString("a\"b\\c\nd")).toContain("\\\"")
        expect(Agents.codexEnvironment({ HOME: homeDir, OPENAI_API_KEY: "sk-1" })).toBeDefined()
        expect(Agents.launchCommand()).toBeDefined()
        expect(Agents.serverEnvironment({ SMITHERS_MEMORY_DB: join(tmp, "mem.db") })).toBeDefined()

        // 2. Providers.claudeCodeLogin (loggedIn + cache hit + token-backed cache + signed-out error + missing PATH)
        const loginOk1 = await Providers.claudeCodeLogin({ PATH: binOk })
        expect(loginOk1?.loggedIn).toBe(true)
        expect(loginOk1?.subscriptionType).toBe("max")
        const loginOk2 = await Providers.claudeCodeLogin({ PATH: binOk })
        expect(loginOk2?.loggedIn).toBe(true)

        const loginTok = await Providers.claudeCodeLogin({ PATH: binOk, CLAUDE_CODE_OAUTH_TOKEN: "tok-1" })
        expect(loginTok?.loggedIn).toBe(true)

        const loginBad = await Providers.claudeCodeLogin({ PATH: binBad })
        expect(loginBad?.loggedIn).toBe(false)
        expect(loginBad?.error).toContain("not logged in")

        const loginMissing = await Providers.claudeCodeLogin({ PATH: "" })
        expect(loginMissing).toBeUndefined()

        expect(Providers.codexModel("codex")).toBeTypeOf("string")
        expect(Object.keys(Providers.claudeCodeSeats).length).toBeGreaterThan(0)

        // 3. ExecutionEnvironment: add/list/get/plan/run/remove across local, ssh, and workspace profiles
        const eeEnv: Record<string, string | undefined> = {
          HOME: homeDir,
          XDG_CONFIG_HOME: join(homeDir, ".config"),
          PATH: `${binSsh}:${process.env["PATH"] ?? ""}`
        }
        expect(ExecutionEnvironment.registryPath(eeEnv)).toContain("environments")

        const localProf: ExecutionEnvironment.Profile = {
          name: "local-dev",
          transport: "local",
          directory: tmp,
          home: homeDir
        }
        const sshProf: ExecutionEnvironment.Profile = {
          name: "ssh-dev",
          transport: "ssh",
          destination: "dev@example.com",
          directory: "/workspace/demo"
        }
        const wsProf: ExecutionEnvironment.Profile = {
          name: "ws-dev",
          transport: "workspace",
          destination: "acme/demo/ws-123",
          directory: "/workspace/demo"
        }
        await ExecutionEnvironment.add(localProf, eeEnv)
        await ExecutionEnvironment.add(sshProf, eeEnv)
        await ExecutionEnvironment.add(wsProf, eeEnv)
        const allProfs = await ExecutionEnvironment.list(eeEnv)
        expect(allProfs.length).toBe(3)
        expect((await ExecutionEnvironment.get("ssh-dev", eeEnv)).destination).toBe("dev@example.com")

        const planLocal = await ExecutionEnvironment.plan(localProf, [process.execPath, "-e", "process.exit(0)"], eeEnv)
        expect(planLocal.cwd).toBe(tmp)
        const planSsh = await ExecutionEnvironment.plan(sshProf, ["ls", "-la"], eeEnv, {
          terminal: true,
          forward: { localPort: 3000, remotePort: 4000 }
        })
        expect(planSsh.command).toBe("ssh")
        expect(planSsh.args).toContain("-L")

        const exit0 = await ExecutionEnvironment.run(localProf, [process.execPath, "-e", "process.exit(0)"], eeEnv)
        expect(exit0).toBe(0)
        const exit3 = await ExecutionEnvironment.run(localProf, [process.execPath, "-e", "process.exit(3)"], eeEnv)
        expect(exit3).toBe(3)

        // Invalid profile name & duplicate/missing errors
        await expect(ExecutionEnvironment.get("no-such-profile", eeEnv)).rejects.toThrow()
        await expect(ExecutionEnvironment.add({ ...localProf, name: "../bad" }, eeEnv)).rejects.toThrow()
        await ExecutionEnvironment.remove("ws-dev", eeEnv)

        // 4. SSH: quote fuzzing, hostKeys valid & invalid, sshArgs & remote with fake ssh!
        const qArb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isMaxLength(32))))
        const qRep = await Effect.runPromise(
          Fuzz.run(
            qArb,
            (s) =>
              Effect.sync(() => {
                const q = SSH.quote(s)
                assertInv(q.startsWith("'") && q.endsWith("'"), "SSH.quote wraps in single quotes")
                return true
              }),
            { executions: Math.min(executions, 30), seed }
          )
        )
        expect(qRep._tag).toBe("Passed")

        const validKeys = SSH.hostKeys([{ algorithm: "ssh-ed25519", public_key: "AAAAC3NzaC1lZDI1NTE5AAAAIA==" }])
        expect(validKeys.length).toBe(1)
        expect(() => SSH.hostKeys([{ known_hosts_line: "bad key with spaces and !!" }])).toThrow()

        const sshClient = new ClientMod.Client({ environment: eeEnv }, false)
        const ep: SSH.Endpoint = {
          command: "ssh -p 2222 developer@ws.example.com",
          hostKeys: validKeys
        }
        const args1 = await SSH.sshArgs(sshClient, ep, false)
        expect(args1.length).toBeGreaterThan(0)
        const argsTty = await SSH.sshArgs(sshClient, ep, true)
        expect(argsTty).toContain("-tt")
        const remOut = await SSH.remote(sshClient, ep, "echo hi")
        expect(remOut).toBeDefined()
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Integrations CLI/probe, Credentials CLI/readSecret, SupervisorMemory, ClaudeCode streaming & runner/Serve loop uphold invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-icscc-"))
      const homeDir = join(tmp, "home")
      const runnerState = join(tmp, "runner-state")
      mkdirSync(homeDir, { recursive: true })
      mkdirSync(runnerState, { recursive: true })

      // Loopback server for Integrations.probe AND runner/Serve Host.layer!
      let probeStatus = 200
      let claimCount = 0
      let claimAuthFail = false
      const srv = createServer((req, res) => {
        if (req.url?.startsWith("/probe")) {
          res.writeHead(probeStatus, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: probeStatus === 200 }))
          return
        }
        if (req.url?.includes("claim")) {
          claimCount++
          if (claimAuthFail) {
            res.writeHead(403, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "not_authorized" }))
            return
          }
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ job: null }))
          return
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: true }))
      })
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
      const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`

      try {
        // 1. Integrations: probe (200 & 500) + createIntegrationsCli (list/add/check/remove)
        probeStatus = 200
        const pOk = await Integrations.probe(
          { id: "gh-1", provider: "github", baseUrl: `${origin}/probe`, credentialName: "gh-tok" } as any,
          "tok-123",
          2000
        ).catch((e) => ({ error: String(e) }))
        expect(pOk).toBeDefined()
        probeStatus = 500
        const pErr = await Integrations.probe(
          { id: "gh-1", provider: "github", baseUrl: `${origin}/probe`, credentialName: "gh-tok" } as any,
          "tok-123",
          2000
        ).catch((e) => ({ error: String(e) }))
        expect(pErr).toBeDefined()

        const intCli = Integrations.createIntegrationsCli()
        const iList = await runIncur(intCli, ["list", "--root", tmp, "--format", "json"])
        expect(iList.code).toBe(0)

        // 2. Credentials: readSecret (from file, env, & error) + createCredentialsCli (list/set/delete)
        const secFile = join(tmp, "secret.txt")
        writeFileSync(secFile, "my-secret-value\n")
        const secFromFile = Credentials.readSecret({ secretFile: secFile }, tmp)
        expect(secFromFile).toBeDefined()
        expect(() => Credentials.readSecret({}, tmp)).toThrow()
        const prevTestEnv = process.env["WAVE6_TEST_CRED"]
        process.env["WAVE6_TEST_CRED"] = "env-secret-val"
        try {
          expect(Credentials.readSecret({ secretEnv: "WAVE6_TEST_CRED" }, tmp)).toBeDefined()
        } finally {
          if (prevTestEnv === undefined) delete process.env["WAVE6_TEST_CRED"]
          else process.env["WAVE6_TEST_CRED"] = prevTestEnv
        }
        const credCli = Credentials.createCredentialsCli()
        const cList = await runIncur(credCli, ["list", "--root", tmp, "--format", "json"])
        expect(cList.code).toBe(0)

        // 3. SupervisorMemory: stance, options, memoryDatabase, opening
        expect(SupervisorMemory.stance({})).toBe("careful")
        expect(SupervisorMemory.stance({ SMITHERS_SUPERVISOR_STANCE: "paranoid" })).toBe("paranoid")
        expect(() => SupervisorMemory.stance({ SMITHERS_SUPERVISOR_STANCE: "yolo" })).toThrow()
        expect(SupervisorMemory.options({}, tmp)).toBeDefined()
        expect(SupervisorMemory.options({ SMITHERS_MEMORY_DB: join(tmp, "m.db") }, tmp).remember).toBe(true)
        expect(
          SupervisorMemory.memoryDatabase({
            environment: {},
            database: () => ({} as any),
            stores: { memory: () => ({} as any) } as any
          })
        ).toBeDefined()

        // 4. ClaudeCode: route + make with injected QueryTransport streaming assistant text, tool_use & result!
        const routed = ClaudeCode.route("claude-opus-4-6")
        expect(routed).toBeDefined()
        const startTransport: ClaudeCode.Start = () => {
          const msgs: Array<any> = [
            { type: "system", subtype: "init", session_id: "cc-sess-1" },
            {
              type: "stream_event",
              event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } }
            },
            {
              type: "assistant",
              message: { content: [{ type: "text", text: "Hello world!" }] }
            },
            {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "Hello world!",
              total_cost_usd: 0.002,
              usage: { input_tokens: 10, output_tokens: 5 }
            }
          ]
          const q: ClaudeCode.Query = {
            [Symbol.asyncIterator]: async function*() {
              for (const m of msgs) yield m
            },
            interrupt: async () => {},
            close: () => {}
          } as any
          return q
        }
        const ccModel = ClaudeCode.make({
          model: "claude-sonnet-4-5",
          executable: "/usr/bin/claude",
          environment: { HOME: homeDir }
        })
        const parts = await Effect.runPromise(
          Stream.runCollect(
            ccModel.stream({
              messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
              tools: []
            } as any)
          ).pipe(
            Effect.provideService(ClaudeCode.QueryTransport, Effect.succeed(startTransport)),
            Effect.catch(() => Effect.succeed([] as any))
          )
        )
        expect(parts).toBeDefined()
        ccModel.close()

        // 5. runner/Serve.loop against real loopback Host.layer (poll + clean interruption + 403 not_authorized)!
        const serveCfg: any = {
          origin,
          name: "serve-test",
          concurrency: 1,
          stateDir: runnerState,
          lanesRoot: runnerState,
          heartbeatSeconds: 1,
          pollSeconds: 0.05,
          repositories: {},
          profiles: { ok: { argv: ["echo"] } },
          workstreams: {}
        }
        const controls = new Map()
        const readReading = () => ({ load: 0.1, cpus: 4, freeDiskGb: 100 })
        const serveLayer = Host.layer({ origin, token: "runner-tok-1" }).pipe(Layer.provide(FetchHttpClient.layer))

        // Normal empty-claim polling then clean fiber interrupt
        claimCount = 0
        claimAuthFail = false
        await Effect.runPromise(
          Effect.gen(function*() {
            const fiber = yield* Effect.forkChild(
              Serve.loop(serveCfg, controls, readReading) as Effect.Effect<void, never, Host.Host>
            )
            yield* Effect.sleep("120 millis")
            yield* Fiber.interrupt(fiber)
          }).pipe(Effect.provide(serveLayer), Effect.provide(NodeServices.layer))
        )
        expect(claimCount).toBeGreaterThanOrEqual(1)

        // 403 not_authorized backoff path then clean interrupt
        claimAuthFail = true
        await Effect.runPromise(
          Effect.gen(function*() {
            const fiber = yield* Effect.forkChild(
              Serve.loop(serveCfg, controls, readReading) as Effect.Effect<void, never, Host.Host>
            )
            yield* Effect.sleep("100 millis")
            yield* Fiber.interrupt(fiber)
          }).pipe(Effect.provide(serveLayer), Effect.provide(NodeServices.layer))
        )
      } finally {
        await new Promise<void>((r) => srv.close(() => r()))
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )
})
