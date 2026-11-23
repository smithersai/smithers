import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePathLayer from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { Smithers as S } from "@smthrs/targets"
import type * as AgentTarget from "@smthrs/targets/AgentTarget"
import type * as Factory from "@smthrs/targets/Factory"
import { Arbitrary, Effect, Layer, Schema } from "effect"
import * as Crypto from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AgentFake from "../src/AgentFake.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as DockerExec from "../src/DockerExec.ts"
import * as Engine from "../src/engine.ts"
import * as FactoryLoader from "../src/FactoryLoader.ts"
import * as FactoryProjectionExec from "../src/FactoryProjectionExec.ts"
import * as FetchExec from "../src/FetchExec.ts"
import * as ApprovalBridge from "../src/internal/ApprovalBridge.ts"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as FetchExecutor from "../src/internal/rules/FetchExecutor.ts"
import * as FetchPlan from "../src/internal/rules/FetchPlan.ts"
import * as NativeRules from "../src/internal/rules/NativeRules.ts"
import * as SkillsInstallRule from "../src/internal/rules/SkillsInstallRule.ts"
import * as MemoryBackend from "../src/MemoryBackend.ts"
import * as Mount from "../src/Mount.ts"
import * as NixExec from "../src/NixExec.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"
import * as TrustedReview from "../src/TrustedReview.ts"
import { write } from "./helpers/WriteFile.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const fsExecutions = Math.min(executions, 20)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const nodeFsLayer = Layer.mergeAll(NodeFileSystem.layer, NodePathLayer.layer)

describe("@smthrs/build-cli AgentSession, ServiceSupervisor, Fetch, Docker, Nix, Machine, ApprovalBridge, Skills, Factory & Engine fuzz invariants", () => {
  it("AgentSession pure helpers, DockerExec, NixExec, MemoryBackend, Machine, Engine, FetchExecutor URL/redirect & NativeRules invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        model: Schema.Literals(["claude-sonnet-4-6", "gpt-5.4", "claude-opus-4-7"]),
        engine: Schema.Literals(["claude", "codex"]),
        tag: Schema.Literals(["app:1.0.0", "app:latest", "app:dev", "ghcr.io/org/img@sha256:" + "a".repeat(64)]),
        version: Schema.Literals(["1.2.3", "2.0.0", "0.9.1", "22.14.0"]),
        req: Schema.Literals([">=1.0.0", "^1.0.0", "2.0.0", ">=20.0.0", "invalid"]),
        durText: Schema.Literals(["500ms", "15s", "2m", "1h", "0ms", "-5s", "bogus"]),
        urlInput: Schema.Literals([
          "https://user:secret@example.com/file.tar.gz?token=abc#frag",
          "https://cdn.example.com/pkg.tgz",
          "http://127.0.0.1:8080/a/b"
        ]),
        machineName: Schema.Literals(["m1", "test/unit:a", "build-worker-2"]),
        textFrag: Schema.String.check(Schema.isMaxLength(64))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ model, engine, tag, version, req, durText, urlInput, machineName, textFrag }) =>
          Effect.sync(() => {
            const safeFrag = textFrag.replace(/[\uD800-\uDFFF]/g, "")

            // AgentSession pure helpers
            const envJson = JSON.stringify({
              findings: [{ file: "src/a.ts", line: 1, severity: "warning", message: `msg ${safeFrag}` }],
              edits: [],
              note: "ok"
            })
            const parsedEnv = AgentSession.parseEnvelope(envJson)
            if (parsedEnv.findings.length !== 1) throw new Error("parseEnvelope findings")

            const agentsDecl = S.Agents({
              default: S.Agent.ClaudeCode({ model: "claude-sonnet-4-6" }),
              fast: S.Agent.Codex({ model: "gpt-5.4" }),
              pool: S.Agent.Pool(["default", "fast"])
            })
            const selector = engine === "claude" ? S.Agent.ClaudeCode({ model }) : S.Agent.Codex({ model })
            const r1 = AgentSession.resolveAgents(agentsDecl, selector)
            const rPool = AgentSession.resolveAgents(agentsDecl, { _tag: "AgentRef", name: "pool" })
            if (r1.length !== 1 || rPool.length !== 2) throw new Error("resolveAgents")
            const id1 = AgentSession.agentIdentityOf(rPool)
            const id2 = AgentSession.agentIdentityOf(rPool)
            if (id1 !== id2 || id1.length === 0) throw new Error("agentIdentityOf")

            const codexErrs = AgentSession.codexErrorMessages(
              `${JSON.stringify({ type: "error", message: "rate limit" })}\nnot-json\n`
            )
            if (codexErrs.length !== 1) throw new Error("codexErrorMessages")

            const mcpCfg = AgentSession.claudeMcpConfig([
              S.Mcp.Http("docs", "https://mcp.example.invalid/sse")
            ])
            if (!mcpCfg.includes("docs")) throw new Error("claudeMcpConfig")

            const vk1 = AgentSession.verdictKey({
              kind: "diff",
              diffDigest: "a".repeat(64),
              promptDigest: "b".repeat(64),
              agentIdentity: id1,
              mode: "check",
              gateIdentities: ["//:test"]
            })
            if (vk1.length !== 64) throw new Error("verdictKey")

            AgentFake.promptFilesOf(`--- a/src/a.ts\n+++ b/src/a.ts\n${safeFrag}`)
            AgentFake.sessionTimeoutFromEnvironment({ [AgentFake.timeoutEnvironmentVariable]: "5000" })

            // ServiceSupervisor.parseDurationMs
            const badDur = durText === "0ms" || durText === "-5s" || durText === "bogus"
            try {
              const ms = ServiceSupervisor.parseDurationMs(durText, "readiness")
              if (badDur || ms <= 0) throw new Error("bad duration accepted")
            } catch (e) {
              if (!badDur) throw e
            }

            // DockerExec pure helpers
            DockerExec.outputDir("Docker.Build", "apps/web", { dockerfile: S.file("Dockerfile"), context: "." })
            const refusal = DockerExec.pushTagRefusal(tag)
            if (tag.endsWith(":latest") && refusal === undefined) throw new Error("latest tag not refused")
            DockerExec.imageArchive("dist/docker")
            const ids = DockerExec.loadedImageIds("Loaded image: app:1.0.0\nLoaded image ID: sha256:" + "1".repeat(64))
            if (ids.length === 0) throw new Error("loadedImageIds")
            const pushed = DockerExec.pushedDigest(`latest: digest: sha256:${"2".repeat(64)} size: 1234`)
            if (pushed === undefined) throw new Error("pushedDigest")

            // NixExec.satisfies
            NixExec.satisfies(version, req)

            // MemoryBackend pure helpers
            const cmds = MemoryBackend.parseMemoryHelpCommands("Commands:\n  get   Get key\n  set   Set key\n  list  List\n  rm    Remove\n")
            if (!cmds.includes("get")) throw new Error("parseMemoryHelpCommands")
            MemoryBackend.assertMemoryCliCommand("get")
            MemoryBackend.pathLocator({ PATH: "/usr/bin" })

            // FetchExecutor pure URL/redirect + FetchPlan
            const redactedUrl = FetchExecutor.redactUrl(urlInput)
            if (redactedUrl.includes("secret") || redactedUrl.includes("token=abc")) {
              throw new Error("redactUrl leaked secret: " + redactedUrl)
            }
            const redir = FetchExecutor.redirectTarget("https://example.com/a/b", "/c/d")
            if (redir !== "https://example.com/c/d") throw new Error("redirectTarget")
            FetchPlan.planAttrs({
              packagePath: "packages/a",
              attrs: { url: "https://example.com/pkg.tgz", sha256: "a".repeat(64), out: "vendor/pkg.tgz" }
            })
            FetchExec.plan({
              packagePath: "packages/a",
              target: S.Fetch({ url: "https://example.com/pkg.tgz", sha256: "a".repeat(64), out: "vendor/pkg.tgz" })
            })
            NativeRules.get("Fetch")
            NativeRules.get("Docs.Check")
            NativeRules.get("Unknown.Rule")

            // Machine pure helpers
            Machine.toKeep({ [Machine.keepVariable]: "1" })
            Machine.skippedPart("packages/a/node_modules/x")
            Machine.skippedPart("packages/a/src/x.ts")
            const kept = Machine.holding("/work/ws", { [Machine.holdingVariable]: "/tmp/m-hold" })
            Machine.formerHolding("/work/ws", { HOME: "/tmp" })
            Machine.holdPath(kept, "linux")
            const mach = Machine.named(kept, "/work/ws", machineName)
            const mEnv = Machine.environment(mach)
            if (mEnv["HOME"] !== mach.home) throw new Error("Machine.environment")
            Machine.homeLinks([{ path: ".gitconfig", target: "/home/u/.gitconfig" }])
            Machine.remover(mach.directory)
            const scrubbedCfg = Machine.withoutCredentials("[url \"https://tok@github.com\"]\n  insteadOf = https://github.com\n")
            if (scrubbedCfg.includes("tok@")) throw new Error("withoutCredentials leaked token")
            Machine.sharedRefusal("m1", "m2", "conflict")
            Machine.tmpBinds(mach, [])
            Machine.mountsOf(mach.tmp, [])
            const reloc = Machine.relocated(`/work/ws/packages/a:${safeFrag}`, "/work/ws", mach.tree, ".flows")
            if (!reloc.includes(mach.tree)) throw new Error("Machine.relocated")
            const neut = Machine.neutral(mach)(`${mach.tree}/src/a.ts`)
            if (!neut.startsWith(Machine.anchor)) throw new Error("Machine.neutral")
            Machine.own(Machine.homeVariable)
            Machine.actual(mach)(`${Machine.anchor}/src/a.ts`)

            // Engine pure helpers
            const pmEnv = Engine.packageManagerEnvironment(
              { PATH: "/usr/bin", SMITHERS_CACHE_TOKEN: "secret", CUSTOM_SECRET: "hide" },
              ["CUSTOM_SECRET"]
            )
            if (pmEnv["SMITHERS_CACHE_TOKEN"] !== undefined || pmEnv["CUSTOM_SECRET"] !== undefined) {
              throw new Error("packageManagerEnvironment leaked secret")
            }
            Engine.targetToolchain("Vitest", {})
            Engine.declaredToolchain({})
            Engine.credentialHostsOf({ [Engine.credentialHostsVariable]: "npm.pkg.github.com,registry.npmjs.org" })

            // FactoryLoader pure helpers
            FactoryLoader.factoryFileBeside("/work/ws/WORKSPACE.ts")
            return true
          }),
        { executions, seed: seed + 30 }
      )
    )
    assertPassed(report)
  })

  it("Real AgentSession runAgentDiff/runAgentPr (scripted), ServiceSupervisor live process, FetchExecutor live HTTP download, ApprovalBridge, SkillsInstallRule, FactoryProjectionExec & ContainedProcess", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-buildcli-exec-")))
    // Live HTTP server for FetchExecutor (200 + 302 redirect + 404)
    const fetchPayloads = new Map<string, Buffer>([
      ["/ok.txt", Buffer.from("hello-fetch-payload\n", "utf8")],
      ["/alt.txt", Buffer.from("redirected-payload\n", "utf8")]
    ])
    const httpServer = Http.createServer((req, res) => {
      if (req.url === "/redir") {
        res.writeHead(302, { location: "/alt.txt" }).end()
        return
      }
      const hit = fetchPayloads.get(req.url ?? "")
      if (hit !== undefined) {
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(hit)
        return
      }
      res.writeHead(404).end("not found")
    })
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve))
    const addr = httpServer.address()
    if (!addr || typeof addr === "string") throw new Error("no fetch server port")
    const baseUrl = `http://127.0.0.1:${addr.port}`

    try {
      // 1. Live FetchExecutor.download (success, redirect, sha256 mismatch refusal)
      const okBuf = fetchPayloads.get("/ok.txt")!
      const okSha = Crypto.createHash("sha256").update(okBuf).digest("hex")
      const altBuf = fetchPayloads.get("/alt.txt")!
      const altSha = Crypto.createHash("sha256").update(altBuf).digest("hex")

      const dl1 = await FetchExecutor.download({
        root: tmpRoot,
        url: `${baseUrl}/ok.txt`,
        sha256: okSha,
        outFile: "downloads/ok.txt"
      })
      expect(dl1.sha256).toBe(okSha)
      expect(dl1.bytes).toBe(okBuf.byteLength)

      const dl2 = await FetchExecutor.download({
        root: tmpRoot,
        url: `${baseUrl}/redir`,
        sha256: altSha,
        outFile: "downloads/alt.txt"
      })
      expect(dl2.sha256).toBe(altSha)

      await expect(
        FetchExecutor.download({
          root: tmpRoot,
          url: `${baseUrl}/ok.txt`,
          sha256: "0".repeat(64),
          outFile: "downloads/bad.txt"
        })
      ).rejects.toThrow()

      // 2. Live ApprovalBridge serve/withBridge/client
      const grantedResult = await ApprovalBridge.withBridge(
        {
          granted: async (req) => req.label === "//:deploy" && req.digest === "d".repeat(64)
        },
        async (env) => {
          const cli = ApprovalBridge.client(env[ApprovalBridge.environmentName])
          if (cli === undefined) throw new Error("bridge client undefined")
          const yes = await cli.granted({ root: tmpRoot, label: "//:deploy", digest: "d".repeat(64) })
          const no = await cli.granted({ root: tmpRoot, label: "//:other", digest: "d".repeat(64) })
          return { yes, no }
        }
      )
      expect(grantedResult).toEqual({ yes: true, no: false })

      // 3. Live ContainedProcess.run
      const exit0 = await ContainedProcess.run({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: tmpRoot,
        stdout: () => {},
        stderr: () => {}
      })
      expect(exit0).toBe(0)
      const exit7 = await ContainedProcess.run({
        command: process.execPath,
        args: ["-e", "process.exit(7)"],
        cwd: tmpRoot,
        stdout: () => {},
        stderr: () => {}
      })
      expect(exit7).toBe(7)

      // 4. Live ServiceSupervisor starting a real tiny node HTTP readiness service
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const sup = yield* ServiceSupervisor.make
            // Pick a free ephemeral port cleanly
            const probeSrv = Http.createServer((_req, res) => res.end("ok"))
            yield* Effect.promise(
              () => new Promise<void>((resolve) => probeSrv.listen(0, "127.0.0.1", resolve))
            )
            const svcAddr = probeSrv.address()
            if (!svcAddr || typeof svcAddr === "string") throw new Error("no svc port")
            const port = svcAddr.port
            yield* Effect.promise(() => new Promise<void>((resolve) => probeSrv.close(() => resolve())))

            const handle = yield* sup.acquire({
              key: "//:fuzz-svc",
              cwd: tmpRoot,
              argv: [
                process.execPath,
                "-e",
                `const http=require("node:http");http.createServer((q,s)=>{s.writeHead(200);s.end("ready")}).listen(${port},"127.0.0.1");`
              ],
              readiness: {
                http: `http://127.0.0.1:${port}/health`,
                timeout: "5s"
              },
              stop: { signal: "SIGTERM", grace: "2s" }
            })
            expect(handle.pid).toBeGreaterThan(0)
            const body = yield* handle.whileHealthy(
              Effect.promise(async () => {
                const resp = await fetch(`http://127.0.0.1:${port}/health`)
                return resp.text()
              })
            )
            expect(body).toBe("ready")
          })
        )
      )

      // 5. Real SkillsInstallRule.install (valid + escape refusal)
      await write(tmpRoot, "skills/hello/SKILL.md", "---\nname: hello\ndescription: hi\n---\n# Hello\n")
      const skillHome = NodePath.join(tmpRoot, "fake-home")
      await Fs.mkdir(skillHome, { recursive: true })
      const installed = await Effect.runPromise(
        SkillsInstallRule.install(
          { library: { root: "skills" }, agents: ["claude", "codex"] },
          { root: tmpRoot, home: skillHome }
        ).pipe(Effect.provide(nodeFsLayer))
      )
      expect(installed.installed.length).toBeGreaterThanOrEqual(2)
      const escapedExit = await Effect.runPromise(
        Effect.result(
          SkillsInstallRule.install(
            { library: { root: "../outside" }, agents: ["claude"] },
            { root: tmpRoot, home: skillHome }
          ).pipe(Effect.provide(nodeFsLayer))
        )
      )
      expect(escapedExit._tag).toBe("Failure")

      // 6. Real FactoryProjectionExec.discoverFlows + renderProjection
      await write(
        tmpRoot,
        ".smithers/flows/demo/flow.ts",
        `export default { tag: "demo" }\n`
      )
      await write(
        tmpRoot,
        ".smithers/flows/demo/SKILL.md",
        `---\nname: demo\ndescription: Demo flow\n---\n# Demo\n`
      )
      const factoryDecl = S.Factory({ summary: "fuzz" })
      const loadedFac = FactoryLoader.validateFactoryModule({ factory: factoryDecl }, NodePath.join(tmpRoot, "FACTORY.ts"))
      expect(loadedFac.factory).toBeDefined()
      const discoveredFlows = await Effect.runPromise(
        FactoryProjectionExec.discoverFlows(tmpRoot, ".smithers/flows").pipe(Effect.provide(nodeFsLayer))
      )
      expect(Array.isArray(discoveredFlows)).toBe(true)
      const projPayload: Factory.Payload = {
        factory: factoryDecl,
        home: null,
        root: ".smithers/flows",
        mode: "write",
        output: ".smithers/factory.json",
        homeOutput: ".smithers/home.json"
      }
      await Effect.runPromise(
        Effect.result(
          FactoryProjectionExec.renderProjection(tmpRoot, projPayload).pipe(Effect.provide(nodeFsLayer))
        )
      )

      // 7. Real AgentSession.renderDataFiles, decodePayloadValues, Mount.loadConfig/summary & TrustedReview.prepareSource
      await write(tmpRoot, "prompts/fix.md", "Fix the bug in src/target.ts.\n")
      await write(tmpRoot, "src/target.ts", "export const v = 1\n")
      const renderedFiles = await Effect.runPromise(AgentSession.renderDataFiles(tmpRoot, ["src/target.ts"]))
      expect(renderedFiles).toContain("src/target.ts")
      const decodedPv = await Effect.runPromise(
        AgentSession.decodePayloadValues({ note: { _tag: "InputSpec", type: "string", required: true } } as never, {
          note: "hello"
        })
      ).catch(() => undefined)
      void decodedPv

      // Mount.loadConfig (absent -> empty) & Mount.summary
      const mountCfg = await Mount.loadConfig(tmpRoot).catch(() => undefined)
      void mountCfg
      expect(
        Mount.summary({
          name: "dep",
          root: NodePath.join(tmpRoot, ".mounts/dep"),
          overlayRoot: tmpRoot,
          repository: "https://example.invalid/dep.git",
          pin: "v1.0.0",
          base: "a".repeat(40),
          head: "b".repeat(40),
          patches: ["patches/01.patch"],
          drift: { state: "current", track: "main", tip: "a".repeat(40) }
        }).length
      ).toBeGreaterThan(0)

      // TrustedReview.prepareSource with in-memory ReviewSource
      const idxJson = JSON.stringify([
        {
          label: "//:sec",
          package: "",
          name: "sec",
          target: "Llm.Lint",
          kinds: ["lint"],
          attrs: {
            prompt: { _tag: "File", path: "prompts/fix.md" },
            files: [{ _tag: "File", path: "src/target.ts" }],
            budget: { maxFiles: 10, maxBytes: 100000 }
          }
        }
      ])
      const memFiles = new Map<string, string>([
        [".smithers/target-index.json", idxJson],
        ["prompts/fix.md", "Review src/target.ts\n"],
        ["src/target.ts", "export const v = 1\n"]
      ])
      const memEntries = new Map<string, TrustedReview.SourceEntry>(
        [...memFiles.entries()].map(([path]) => [path, { id: "1".repeat(40), regular: true }])
      )
      const memSource: TrustedReview.ReviewSource = {
        tree: async () => memEntries,
        read: async (_rev, path) => memFiles.get(path) ?? "",
        grep: async () => []
      }
      const preparedRev = await TrustedReview.prepareSource(memSource, {
        policyRevision: "HEAD",
        revision: "HEAD",
        patterns: [{ _tag: "Subtree", packagePath: "", target: undefined }]
      }).catch(() => undefined)
      if (preparedRev !== undefined) {
        TrustedReview.governing(preparedRev)
      }

      // 8. Fuzz real AgentSession.runAgentDiff & runAgentPr with scripted SessionFactory + GateRunner + FileVerdictStore
      const verdictDir = NodePath.join(tmpRoot, ".flows/verdicts")

      const arb = Arbitrary.schema(
        Schema.Struct({
          passFirstRound: Schema.Boolean,
          withPrOpener: Schema.Boolean,
          newVal: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 50 })),
          useFileStore: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ passFirstRound, withPrOpener, newVal, useFileStore }) =>
            Effect.gen(function*() {
              const makeRuntime = () => {
                const scriptedSessions = AgentFake.makeScriptedSessionFactory({
                  identity: `fuzz-agent-${newVal}`,
                  responses: [
                    {
                      findings: [],
                      edits: [{ path: "src/target.ts", contents: `export const v = ${newVal}\n` }],
                      note: "round 1 edit"
                    },
                    {
                      findings: [],
                      edits: [{ path: "src/target.ts", contents: `export const v = ${newVal + 1}\n` }],
                      note: "round 2 edit"
                    }
                  ]
                })
                const scriptedGates = AgentFake.makeScriptedGateRunner(
                  passFirstRound
                    ? [[{ gate: "//:test", status: "green", detail: "green" }]]
                    : [
                        [{ gate: "//:test", status: "red", detail: "red round 1" }],
                        [{ gate: "//:test", status: "green", detail: "green round 2" }]
                      ]
                )
                const verdicts = useFileStore
                  ? AgentSession.makeFileVerdictStore(verdictDir)
                  : AgentSession.makeMemoryVerdictStore()
                const rt: AgentSession.AgentRuntime = {
                  workspaceRoot: tmpRoot,
                  sessions: scriptedSessions,
                  writeSets: AgentSession.makeLocalWriteSetApplier(tmpRoot),
                  gates: scriptedGates,
                  verdicts,
                  dataFiles: ["src/target.ts"],
                  prOpener: withPrOpener
                    ? {
                        open: () => Effect.succeed("https://github.com/acme/repo/pull/42")
                      }
                    : AgentSession.unavailablePrOpener
                }
                return rt
              }

              const payload: AgentTarget.DiffPayload = {
                agent: S.Agent.ClaudeCode({ model: "claude-sonnet-4-6" }),
                promptPath: "prompts/fix.md",
                payloadSpec: {},
                mcp: [],
                diffs: [],
                changes: ["src/**"],
                gateIdentities: ["//:test"],
                maxRounds: 3
              }

              const diffRes = yield* Effect.result(AgentSession.runAgentDiff(makeRuntime(), payload))
              if (diffRes._tag !== "Success") {
                throw new Error(`runAgentDiff failed: ${String(diffRes.failure)}`)
              }
              if (diffRes.success.rounds < 1) throw new Error("runAgentDiff rounds < 1")

              const prRes = yield* Effect.result(AgentSession.runAgentPr(makeRuntime(), payload))
              if (withPrOpener && prRes._tag !== "Success") {
                throw new Error(`runAgentPr failed with opener: ${String(prRes.failure)}`)
              }
              if (!withPrOpener && prRes._tag !== "Failure") {
                throw new Error("runAgentPr unexpectedly succeeded without opener")
              }
              return true
            }),
          { executions: fsExecutions, seed: seed + 31 }
        )
      )
      assertPassed(report)
    } finally {
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections()
        httpServer.close(() => resolve())
      })
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
