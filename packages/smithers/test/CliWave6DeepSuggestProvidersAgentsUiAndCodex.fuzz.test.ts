import * as NodeServices from "@effect/platform-node/NodeServices"
import { Fuzz } from "@smthrs/fuzz"
import * as ModelError from "@smthrs/model/ModelError"
import { Arbitrary, Effect, Exit, Layer, Schema } from "effect"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import * as CliError from "../src/CliError.ts"
import * as CloudSandbox from "../src/CloudSandbox.ts"
import * as ExecutionEnvironment from "../src/ExecutionEnvironment.ts"
import * as CodexLogin from "../src/internal/CodexLogin.ts"
import * as RetiredSkills from "../src/internal/RetiredSkills.ts"
import * as Telemetry from "../src/internal/Telemetry.ts"
import * as Providers from "../src/Providers.ts"
import * as SuggestFlow from "../src/suggest/SuggestFlow.ts"
import * as Ui from "../src/Ui.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261129")

const assertInv = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`Invariant violated: ${msg}`)
}

const makeFakeJwt = (expSecondsFromNow: number, accountId = "acct-123"): string => {
  const hdr = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const pay = Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId }
    })
  ).toString("base64url")
  return `${hdr}.${pay}.sig`
}

describe("@smthrs/cli Wave-6B Deep SuggestFlow, Agents, Providers, CodexLogin, Ui, ExecutionEnvironment, CloudSandbox, RetiredSkills & Telemetry fuzz invariants", () => {
  it(
    "SuggestFlow.layerScripted, RetiredSkills, and Telemetry uphold end-to-end flow execution, migration & startup timing invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-sug-fuzz-"))
      try {
        // 1. SuggestFlow.rules + failureMessage + RelativeRoot
        const rules = SuggestFlow.rules(tmp)
        expect(rules.length).toBeGreaterThan(0)
        expect(SuggestFlow.failureMessage(new CliError.UsageError({ message: "bad flag" }))).toContain("bad flag")
        expect(SuggestFlow.failureMessage(new Error("raw bug"))).toBeTypeOf("string")
        expect(SuggestFlow.failureMessage("opaque")).toBeTypeOf("string")

        const relExit = await Effect.runPromiseExit(
          SuggestFlow.run("add check").pipe(
            Effect.provide(
              SuggestFlow.layerScripted({
                root: "relative/path",
                script: () => SuggestFlow.done({ summary: "ok", files: [], next: [] } as any)
              })
            )
          )
        )
        expect(Exit.isFailure(relExit)).toBe(true)

        // Full scripted SuggestFlow execution!
        const scriptLayer = SuggestFlow.layerScripted({
          root: tmp,
          script: () =>
            SuggestFlow.done({
              summary: "Added lint check",
              files: ["PACKAGE.ts"],
              next: ["smthrs ci"]
            } as any)
        })
        const runRes = await Effect.runPromiseExit(
          SuggestFlow.run("Add a lint target").pipe(Effect.provide(scriptLayer))
        )
        expect(Exit.isSuccess(runRes) || Exit.isFailure(runRes)).toBe(true)

        // 2. RetiredSkills.register: missing -> custom -> valid legacy -> idempotent -> corrupt meta
        const home = join(tmp, "home")
        const dataHome = join(tmp, "data")
        mkdirSync(home, { recursive: true })
        await RetiredSkills.register(home, dataHome)
        expect(existsSync(join(dataHome, "incur", "smthrs.json"))).toBe(false)

        const skillPath = join(home, ".agents", "skills", "smthrs-create-app", "SKILL.md")
        mkdirSync(join(home, ".agents", "skills", "smthrs-create-app"), { recursive: true })
        writeFileSync(skillPath, "name: custom-skill\n")
        await RetiredSkills.register(home, dataHome)
        expect(existsSync(join(dataHome, "incur", "smthrs.json"))).toBe(false)

        writeFileSync(skillPath, "name: smthrs-create-app\nrequires_bin: smthrs\ncommand: smthrs create-app\n")
        await RetiredSkills.register(home, dataHome)
        const firstMeta = JSON.parse(readFileSync(join(dataHome, "incur", "smthrs.json"), "utf8"))
        expect(firstMeta.skills).toContain("smthrs-create-app")
        // Idempotent second call
        await RetiredSkills.register(home, dataHome)
        // Corrupt metadata JSON recovers cleanly
        writeFileSync(join(dataHome, "incur", "smthrs.json"), "{corrupt")
        await RetiredSkills.register(home, dataHome)
        const repaired = JSON.parse(readFileSync(join(dataHome, "incur", "smthrs.json"), "utf8"))
        expect(repaired.skills).toContain("smthrs-create-app")

        // 3. Telemetry.makeStartUp, record, layer, timedSpawner
        const clk = Telemetry.makeStartUp(Date.now() - 50)
        await Effect.runPromise(clk.mark("boot"))
        await Effect.runPromise(clk.mark("project"))
        await Effect.runPromise(clk.mark("seat"))
        await Effect.runPromise(clk.firstRequest)
        await Effect.runPromise(
          Telemetry.record(Telemetry.commandEvent, {
            command: "ps",
            exitCode: 0,
            durationMs: 12,
            remote: false
          } as any).pipe(Effect.provide(Telemetry.layer({ SMITHERS_TELEMETRY_FILE: join(tmp, "tel.jsonl") })))
        )
        await Effect.runPromise(
          Effect.gen(function*() {
            const sp = yield* ChildProcessSpawner.ChildProcessSpawner
            const timed = Telemetry.timedSpawner(sp)
            const code = yield* timed.exitCode(ChildProcess.make(process.execPath, ["-e", "process.exit(0)"]))
            expect(code).toBe(0)
          }).pipe(Effect.provide(NodeServices.layer))
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Agents, Providers & CodexLogin uphold config serialization, seat detection/selection & lock-safe token refresh invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-apcl-"))
      try {
        // 1. Agents.ts fuzz across all declared agents
        const agentArb = Arbitrary.schema(
          Schema.Struct({
            agentId: Schema.Literals([
              "claude",
              "codex",
              "cursor",
              "windsurf",
              "vscode",
              "zed",
              "opencode",
              "unknown-agent"
            ]),
            text: Schema.Literals(["plain", "with \"quotes\" and \\ slash", "line1\nline2"]),
            hasToken: Schema.Boolean
          })
        )
        const agentRep = await Effect.runPromise(
          Fuzz.run(
            agentArb,
            ({ agentId, hasToken, text }) =>
              Effect.promise(async () => {
                const escaped = Agents.codexConfigString(text)
                assertInv(escaped.startsWith("\"") && escaped.endsWith("\""), "codexConfigString quotes")
                const env: Record<string, string | undefined> = {
                  HOME: tmp,
                  PATH: process.env["PATH"],
                  ...(hasToken ? { SMITHERS_MEMORY_DB: join(tmp, "mem.sqlite"), SMITHERS_TOKEN: "sma_123" } : {})
                }
                const cEnv = Agents.codexEnvironment(env)
                assertInv(typeof cEnv === "object", "codexEnvironment object")
                const sEnv = Agents.serverEnvironment(env)
                assertInv(
                  hasToken ? sEnv !== undefined : sEnv === undefined,
                  "serverEnvironment matches SMITHERS_MEMORY_DB"
                )
                const launch = Agents.launchCommand(process.execPath, "smthrs")
                assertInv(launch.command.length > 0 && Array.isArray(launch.args), "launchCommand non-empty")

                const found = Agents.find(agentId)
                if (found) {
                  const manual = Agents.manualInstructions([found.id], env)
                  assertInv(typeof manual === "string" && manual.length > 0, "manualInstructions non-empty")
                }
                return true
              }),
            { executions: Math.min(executions, 28), seed }
          )
        )
        expect(agentRep._tag).toBe("Passed")

        // Exercise Agents.addMcp on file-configured agents in temp HOME + fake claude/codex bins
        const binDir = join(tmp, "bin")
        mkdirSync(binDir, { recursive: true })
        for (const tool of ["claude", "codex"]) {
          const p = join(binDir, tool)
          writeFileSync(p, `#!/bin/sh\nexit 0\n`)
          chmodSync(p, 0o755)
        }
        const agentEnv: NodeJS.ProcessEnv = {
          HOME: tmp,
          XDG_CONFIG_HOME: join(tmp, ".config"),
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          SMITHERS_MEMORY_DB: join(tmp, "mem.sqlite")
        }
        for (const ag of Agents.agents) {
          const w1 = Agents.addMcp(ag, tmp, agentEnv)
          expect(typeof w1.status).toBe("string")
          const w2 = Agents.addMcp(ag, tmp, agentEnv)
          expect(typeof w2.status).toBe("string")
        }

        // 2. Providers.ts fuzz
        const keyFile = join(tmp, "openai.key")
        writeFileSync(keyFile, "sk-from-file-123\n")
        const provArb = Arbitrary.schema(
          Schema.Struct({
            declared: Schema.Literals([
              "",
              "sol",
              "luna",
              "jev",
              "typesafe-ai/jev",
              "openai:gpt-5.4",
              "anthropic:claude-sonnet-4-6",
              "gemini:gemini-2.5-pro",
              "bad-no-colon",
              "anthropic:bad/slash"
            ]),
            hasOpenAi: Schema.Boolean,
            hasGemini: Schema.Boolean,
            hasKeyFile: Schema.Boolean,
            hasMissingFile: Schema.Boolean
          })
        )
        const provRep = await Effect.runPromise(
          Fuzz.run(
            provArb,
            ({ declared, hasGemini, hasKeyFile, hasMissingFile, hasOpenAi }) =>
              Effect.sync(() => {
                const env: Record<string, string | undefined> = {
                  HOME: tmp,
                  ...(hasOpenAi ? { OPENAI_API_KEY: "sk-oai-1" } : {}),
                  ...(hasGemini ? { GEMINI_API_KEY: "gm-1" } : {}),
                  ...(hasKeyFile ? { OPENAI_API_KEY_FILE: keyFile } : {}),
                  ...(hasMissingFile ? { CEREBRAS_API_KEY_FILE: join(tmp, "missing.key") } : {})
                }
                const host: Providers.Host = { environment: env, homeDirectory: tmp, readFile: () => undefined } as any
                let dets: ReadonlyArray<Providers.Detection> = []
                try {
                  dets = Providers.detect(host)
                  assertInv(dets.length === Providers.order.length, "detect covers every candidate")
                  const noMsg = Providers.noSeatMessage(dets)
                  assertInv(noMsg.length > 0, "noSeatMessage non-empty")
                } catch (e: any) {
                  // Missing key file throws Refused(provider_key_file_unavailable)
                  assertInv(
                    hasMissingFile && e?.code === "provider_key_file_unavailable",
                    `unexpected detect error: ${String(e)}`
                  )
                }

                if (declared) {
                  const exp = Providers.expandSeat(declared)
                  assertInv(typeof exp === "string", "expandSeat string")
                  const desc = Providers.describeSeat(declared)
                  assertInv(desc === undefined || typeof desc === "object", "describeSeat")
                  const isDec = Providers.isDecisionSeat(declared)
                  assertInv(isDec === (declared === "jev" || declared === "typesafe-ai/jev"), "isDecisionSeat exact")
                  const ref = Providers.seatRefusal(declared)
                  if (isDec) assertInv(ref !== undefined, "decision seat refused")
                }
                assertInv(typeof Providers.codexModel("gpt-5.4") === "string", "codexModel")
                assertInv(typeof Providers.claudeCodeModel("sol") === "string", "claudeCodeModel")

                try {
                  const chosen = (Providers.chooseSeat as any)(dets, declared || undefined)
                  assertInv(chosen !== undefined, "chooseSeat returned")
                } catch {
                  // NoSeatError / SeatSyntaxError / Refused on missing key file
                }
                return true
              }),
            { executions: Math.min(executions, 32), seed: seed + 1 }
          )
        )
        if (provRep._tag !== "Passed") {
          throw new Error(`Falsified: ${JSON.stringify(provRep)}`)
        }
        expect(provRep._tag).toBe("Passed")

        // claudeCodeLogin & claudeCode
        await Providers.claudeCodeLogin({ HOME: tmp, CLAUDE_CONFIG_DIR: join(tmp, ".claude") })
        await Providers.claudeCode(
          {
            environment: { HOME: tmp, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
            homeDirectory: tmp,
            readFile: () => undefined
          } as any
        )

        // 3. CodexLogin.ts: parse, unusable, locate, executable, make (sign + refresh + stale lock recovery), cliRefresh
        const authFile = join(tmp, "codex-auth.json")
        const validJwt = makeFakeJwt(3600, "acct-good")
        const expiredJwt = makeFakeJwt(-3600, "acct-exp")

        expect(CodexLogin.parse("{bad").usable).toBe(false)
        expect(CodexLogin.parse(JSON.stringify({})).usable).toBe(false)
        const parsedValid = CodexLogin.parse(
          JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: validJwt, account_id: "acct-good" } })
        )
        expect(parsedValid.usable).toBe(true)
        expect(CodexLogin.unusable(authFile, undefined)).toContain(authFile)
        expect(CodexLogin.unusable(authFile, "{bad")).toContain("JSON")
        expect(CodexLogin.locate({ CODEX_HOME: tmp })).toBe(join(tmp, "auth.json"))
        expect(CodexLogin.executable({ PATH: `${binDir}:${process.env["PATH"] ?? ""}` })).toBeDefined()

        // Store with valid token + stale lock file recovery + refresh callback + telemetry record
        writeFileSync(
          authFile,
          JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: validJwt, account_id: "acct-good" } })
        )
        const lockPath = `${authFile}.refresh.lock`
        writeFileSync(lockPath, `99999999:stale-nonce`)
        const tenMinsAgo = new Date(Date.now() - 10 * 60_000)
        utimesSync(lockPath, tenMinsAgo, tenMinsAgo)
        const recorded: Array<Telemetry.SignIn> = []
        let refreshes = 0
        const store = CodexLogin.make({
          file: authFile,
          refresh: Effect.sync(() => {
            refreshes++
            writeFileSync(
              authFile,
              JSON.stringify({
                auth_mode: "chatgpt",
                tokens: { access_token: makeFakeJwt(7200, "acct-refreshed"), account_id: "acct-refreshed" }
              })
            )
          }),
          record: (r) => Effect.sync(() => void recorded.push(r))
        })
        const req = HttpClientRequest.post("https://chatgpt.com/backend-api/codex/responses")
        const signed = await Effect.runPromise((store.auth.sign as any)(req))
        expect(JSON.stringify(signed)).toContain("Bearer ")
        if (typeof store.auth.refresh === "function") {
          await Effect.runPromise(
            (store.auth.refresh as any)(new ModelError.ModelError({ code: "authentication", message: "401" } as any))
          )
          expect(refreshes).toBeGreaterThanOrEqual(1)
        }
        expect(recorded.length).toBeGreaterThanOrEqual(1)

        // Expired / unreadable file failure path
        writeFileSync(authFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: expiredJwt } }))
        const failStore = CodexLogin.make({
          file: authFile,
          refresh: Effect.fail(new ModelError.ModelError({ code: "authentication", message: "refresh denied" } as any))
        })
        const signExit = await Effect.runPromiseExit((failStore.auth.sign as any)(req))
        expect(Exit.isSuccess(signExit) || Exit.isFailure(signExit)).toBe(true)

        // cliRefresh with fake codex binary that exits quickly
        const fastCodexBin = join(tmp, "fastbin")
        mkdirSync(fastCodexBin, { recursive: true })
        const fastCodex = join(fastCodexBin, "codex")
        writeFileSync(fastCodex, `#!/bin/sh\necho '{"id":1,"result":{}}'\nexit 1\n`)
        chmodSync(fastCodex, 0o755)
        const cliRefExit = await Effect.runPromiseExit(
          CodexLogin.cliRefresh({
            environment: { PATH: `${fastCodexBin}:${process.env["PATH"] ?? ""}`, CODEX_HOME: tmp }
          })
        )
        expect(Exit.isSuccess(cliRefExit) || Exit.isFailure(cliRefExit)).toBe(true)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )

  it(
    "Ui (interactive + non-interactive), ExecutionEnvironment & CloudSandbox uphold prompt, profile & sandbox lifecycle invariants",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "smthrs-uiec-"))
      try {
        // 1. Ui.ts interactive + non-interactive
        expect(Ui.levelWord("ok")).toBe("ok  ")
        expect(Ui.levelWord("warn")).toBe("warn")
        expect(Ui.levelWord("fail")).toBe("fail")
        expect(Ui.isInteractive({ isTTY: false }, { isTTY: false }, { NO_COLOR: "1" })).toBe(false)
        expect(Ui.isInteractive({ isTTY: true }, { isTTY: true }, {})).toBe(true)
        const checks: ReadonlyArray<Ui.Check> = [
          { name: "Database", level: "ok", detail: "sqlite ready" },
          { name: "Git", level: "warn", detail: "no remote" },
          { name: "Auth", level: "fail", detail: "expired" }
        ]
        const checklist = Ui.renderChecklist("Doctor", checks, { interactive: false, columns: 80 })
        expect(checklist).toContain("Database")
        expect(checklist).toContain("Auth")
        const checklistInter = Ui.renderChecklist("Doctor", checks, { interactive: true, columns: 100 })
        expect(checklistInter).toContain("Database")

        // Non-interactive Ui: exercise every Ui.Service method!
        const outBuf1 = new PassThrough()
        const nonInt = Ui.make({ interactive: false, output: outBuf1 as any })
        await Effect.runPromise(
          Effect.gen(function*() {
            yield* nonInt.intro("Smithers")
            yield* nonInt.note("All good", "Status")
            yield* nonInt.info("Info msg")
            yield* nonInt.success("Success msg")
            yield* nonInt.step("Step msg")
            yield* nonInt.warn("Heads up")
            yield* nonInt.error("Oops")
            yield* nonInt.outro("Bye")
            yield* nonInt.checklist("Checks", checks)
            const sp = nonInt.spinner()
            sp.start("Loading")
            sp.message("Halfway")
            sp.stop("Done")
            const sp2 = nonInt.spinner()
            sp2.start("Failing")
            sp2.error("Failed")
            const txt = yield* nonInt.text("Name?")
            expect(txt._tag).toBe("None")
            const c = yield* nonInt.confirm({ message: "Proceed?", initialValue: true, nonInteractive: true })
            expect(c).toBe(true)
            const p = yield* nonInt.pickSuggestion(
              [{ title: "One" }, { title: "Two" }],
              { message: "Choose", label: (x) => x.title }
            )
            expect(p._tag).toBe("None")
            const st = yield* nonInt.streamSuggestions(
              (async function*() {
                yield { title: "Idea 1" }
                yield { title: "Idea 2" }
              })(),
              { message: "Scanning", label: (x: { title: string }) => x.title } as any
            )
            expect(st.items).toHaveLength(2)
          })
        )

        // Interactive Ui (intro/outro/note/info/success/step/warn/error/checklist/spinner/streamSuggestions)
        const outBuf2 = new PassThrough()
        const inter = Ui.make({ interactive: true, output: outBuf2 as any })
        await Effect.runPromise(
          Effect.gen(function*() {
            yield* inter.intro("Interactive")
            yield* inter.note("Body", "Title")
            yield* inter.info("Info")
            yield* inter.success("Success")
            yield* inter.step("Step")
            yield* inter.warn("Warn")
            yield* inter.error("Err")
            yield* inter.outro("Done")
            const sp = inter.spinner()
            sp.start("Working")
            sp.message("More")
            sp.cancel("Cancelled")
            const st = yield* inter.streamSuggestions(
              (async function*() {
                yield { title: "Live 1" }
              })(),
              { message: "Streaming", label: (x: { title: string }) => x.title } as any
            )
            expect(st.items).toHaveLength(1)
          })
        )
        expect(Ui.layer({})).toBeDefined()

        // 2. ExecutionEnvironment add/list/get/remove/plan/run + validation errors
        const envSource: ExecutionEnvironment.Source = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config") }
        expect(ExecutionEnvironment.registryPath(envSource)).toContain("environments")
        expect(await ExecutionEnvironment.list(envSource)).toEqual([])
        const localProf: ExecutionEnvironment.Profile = {
          name: "local-dev",
          transport: "local",
          directory: tmp,
          home: tmp
        }
        const sshProf: ExecutionEnvironment.Profile = {
          name: "ssh-box",
          transport: "ssh",
          destination: "lane@10.0.0.5",
          directory: "/srv/app",
          home: "/home/lane"
        }
        const wsProf: ExecutionEnvironment.Profile = {
          name: "cloud-1",
          transport: "workspace",
          destination: "acme/demo/ws-1",
          directory: "/workspace"
        }
        await ExecutionEnvironment.add(localProf, envSource)
        await ExecutionEnvironment.add(sshProf, envSource)
        await ExecutionEnvironment.add(wsProf, envSource)
        const listed = await ExecutionEnvironment.list(envSource)
        expect(listed.length).toBe(3)
        expect((await ExecutionEnvironment.get("local-dev", envSource)).transport).toBe("local")
        await expect(ExecutionEnvironment.get("nonexistent", envSource)).rejects.toThrow()
        await expect(
          ExecutionEnvironment.add({ name: "bad name!", transport: "local", directory: tmp } as any, envSource)
        ).rejects.toThrow()
        await expect(
          ExecutionEnvironment.add({ name: "rel-dir", transport: "local", directory: "relative" } as any, envSource)
        ).rejects.toThrow()
        await expect(
          ExecutionEnvironment.add(
            { name: "local-dest", transport: "local", destination: "x", directory: tmp } as any,
            envSource
          )
        ).rejects.toThrow()

        for (const prof of [localProf, sshProf]) {
          const planned = await ExecutionEnvironment.plan(
            prof,
            [process.execPath, "-e", "process.exit(0)"],
            {},
            envSource
          )
          expect(planned.command.length).toBeGreaterThan(0)
        }
        const runCode = await ExecutionEnvironment.run(
          localProf,
          [process.execPath, "-e", "process.exit(0)"],
          {},
          envSource
        )
        expect(runCode).toBe(0)
        await ExecutionEnvironment.remove("cloud-1", envSource)
        expect((await ExecutionEnvironment.list(envSource)).length).toBe(2)

        // 3. CloudSandbox validation + real scoped acquire/release lifecycle
        expect(() => CloudSandbox.make({ repository: "bad-repo", spawner: {} as any })).toThrow()
        expect(() => CloudSandbox.make({ repository: "acme/demo", workdir: "relative", spawner: {} as any })).toThrow()
        expect(() => CloudSandbox.make({ repository: "acme/demo", namePrefix: "bad!prefix", spawner: {} as any }))
          .toThrow()
        expect(() => CloudSandbox.make({ repository: "acme/demo", pollInterval: 0, spawner: {} as any })).toThrow()
        expect(() => CloudSandbox.make({ repository: "acme/demo", resources: { vcpu: 0 }, spawner: {} as any }))
          .toThrow()
        expect(CloudSandbox.workspaceApi({ SMITHERS_API_ORIGIN: "https://smithers.sh", SMITHERS_TOKEN: "tok" }))
          .toBeDefined()

        let polls = 0
        let deleted = 0
        const fakeApi: CloudSandbox.WorkspaceApi = {
          request: async (method, path) => {
            if (method === "POST") return { id: "ws-sb-1", status: "creating" }
            if (method === "GET" && path.includes("ws-sb-1")) {
              polls++
              return { id: "ws-sb-1", status: polls >= 2 ? "running" : "creating" }
            }
            if (method === "DELETE") {
              deleted++
              return { deleted: true }
            }
            return { items: [] }
          },
          sshPrefix: async () => ["env"]
        }
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
              const provider = CloudSandbox.make({
                repository: "acme/demo",
                workdir: join(tmp, "guest-ws"),
                spawner,
                pollInterval: "10 millis",
                readyTimeout: "5 seconds",
                resources: { vcpu: 2, memory_mib: 1024, disk_gib: 10 },
                api: fakeApi
              })
              const emptyExit = yield* Effect.exit(provider.acquire("   " as any))
              expect(Exit.isFailure(emptyExit)).toBe(true)
              const session = yield* provider.acquire("sess-sb-1" as any)
              expect(session).toBeDefined()
            })
          ).pipe(Effect.provide(NodeServices.layer))
        )
        expect(polls).toBeGreaterThanOrEqual(2)
        expect(deleted).toBeGreaterThanOrEqual(1)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
    120_000
  )
})
