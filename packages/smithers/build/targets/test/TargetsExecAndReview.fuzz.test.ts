import { Fuzz } from "@smthrs/fuzz"
import { Evaluator } from "@smthrs/model"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import { Arbitrary, Effect, Schema, Stream } from "effect"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Exec from "../src/Exec.ts"
import * as ExecSandbox from "../src/ExecSandbox.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as ExecDestinationPolicy from "../src/internal/ExecDestinationPolicy.ts"
import * as ExecEnvironment from "../src/internal/ExecEnvironment.ts"
import * as ExecStage from "../src/internal/ExecStage.ts"
import * as HttpProxyPolicy from "../src/internal/HttpProxyPolicy.ts"
import * as PrivateStore from "../src/internal/PrivateStore.ts"
import * as ReviewBatches from "../src/internal/ReviewBatches.ts"
import * as ReviewEnvironment from "../src/internal/ReviewEnvironment.ts"
import * as ReviewExecutable from "../src/internal/ReviewExecutable.ts"
import * as JevLint from "../src/JevLint.ts"
import * as JobKeeper from "../src/JobKeeper.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"
import * as SecurityReview from "../src/SecurityReview.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"
import { Sandbox } from "../src/WorkspaceDeclaration.ts"
import { plannedCalls } from "./plan.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const fsExecutions = Math.min(executions, 25)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/targets Exec, Sandbox, SecretProxy, LlmLint/JevLint/SecurityReview, ToolBuild, Compose & JobKeeper fuzz invariants", () => {
  it("Exec environment, path resolution, spawnShape, ExecSandbox, ExecStage & real Exec.run preserve invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-exec-")))
    try {
      await Fs.mkdir(NodePath.join(tmpRoot, "dist"), { recursive: true })
      await Fs.writeFile(NodePath.join(tmpRoot, "src.txt"), "hello\n", "utf8")

      const arb = Arbitrary.schema(
        Schema.Struct({
          platform: Schema.Literals(["linux", "darwin", "win32"]),
          hasTool: Schema.Boolean,
          networkMode: Schema.Literals(["default", "none", "false", "loopback", "true"]),
          exitCode: Schema.Literals([0, 1, 2]),
          expectNonZero: Schema.Boolean,
          envKey: Schema.Literals(["FOO_BAR", "CI", "SECRET_KEY"]),
          sensitive: Schema.Boolean,
          withDestinations: Schema.Boolean
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ platform, hasTool, networkMode, exitCode, expectNonZero, envKey, sensitive, withDestinations }) =>
            Effect.gen(function*() {
              const nameKey = ExecEnvironment.nameKey(envKey, platform)
              if (nameKey.length !== envKey.length) throw new Error("nameKey")
              const envRes = Exec.toolEnvironment(
                { [envKey]: "val-123" },
                sensitive ? [envKey] : [],
                { [envKey]: "host-val" }
              )
              if (envRes[envKey] !== "host-val") throw new Error("envRes")

              const inherited = Exec.inheritedValues(["PATH", "NON_EXISTENT_FUZZ_VAR"])
              if (typeof inherited !== "object") throw new Error("inherited")

              if (Exec.resolveWorkspacePath(tmpRoot, ".") !== tmpRoot) throw new Error("resolveWs")
              try {
                Exec.resolveWorkspacePath(tmpRoot, "../escape")
                throw new Error("should reject escape")
              } catch (e) {
                if (e instanceof Error && e.message === "should reject escape") throw e
              }

              const shape = Exec.spawnShape([process.execPath, "-e", "0"])
              if (shape.file !== process.execPath) throw new Error("shape.file")
              Exec.findOnPath("sh")
              Exec.findAllOnPath("sh")
              if (!Exec.isExecutableFile(process.execPath)) throw new Error("isExec true")
              if (Exec.isExecutableFile(NodePath.join(tmpRoot, "missing-bin"))) throw new Error("isExec false")

              const confinement = { mechanism: { _tag: platform === "linux" ? "bubblewrap" : "seatbelt" }, network: "none" }
              const destVal = withDestinations ? ["https://api.github.com"] : undefined
              const isRefused = ExecDestinationPolicy.refused(destVal, confinement, 0)
              const valExit = yield* Effect.exit(
                ExecDestinationPolicy.validate(destVal, confinement, 0, [process.execPath], ".")
              )
              if (isRefused && valExit._tag !== "Failure") throw new Error("dest should fail")
              if (!isRefused && valExit._tag !== "Success") throw new Error("dest should succeed")

              const policy: ExecSandbox.Policy | undefined = networkMode === "default"
                ? undefined
                : networkMode === "none"
                ? "none"
                : networkMode === "false"
                ? { network: false }
                : networkMode === "loopback"
                ? { network: "loopback" }
                : { network: true }

              const net = ExecSandbox.network(policy)
              if (networkMode === "none" && net !== "open") return false
              if (networkMode === "false" && net !== "none") return false
              if (networkMode === "loopback" && net !== "loopback") return false

              const host: ExecSandbox.Host = {
                platform,
                executable: (name) => {
                  if (!hasTool) return undefined
                  if (platform === "linux" && name === "bwrap") return "/usr/bin/bwrap"
                  if (platform === "darwin" && name === "/usr/bin/sandbox-exec") return "/usr/bin/sandbox-exec"
                  return undefined
                },
                exists: (p) => p.includes("src.txt") || p.includes("dist"),
                isDirectory: (p) => p.includes("dist"),
                isSymbolicLink: () => false,
                realpath: (p) => p,
                uid: 501,
                gid: 20
              }
              const req: ExecSandbox.Request = {
                policy,
                reads: ["src.txt", "../outside"],
                writes: ["dist"],
                writeFiles: ["dist/out.txt"],
                readOnly: [".cache"]
              }
              const sel = ExecSandbox.select(req, host)
              const enf = ExecSandbox.enforceable(req, host)
              if (policy === "none" && enf) return false
              if (sel._tag === "bubblewrap" || sel._tag === "seatbelt") {
                const planned = ExecSandbox.plan(req, { workspaceRoot: tmpRoot, cwd: tmpRoot, tmp: Os.tmpdir() }, host)
                if (planned !== undefined && !ExecSandbox.isUnenforceable(planned)) {
                  const wrapped = ExecStage.render(planned, () => ({ argv: [process.execPath, "-e", "0"] }))
                  ExecStage.exceeds(wrapped.wrapped.argv)
                }
              }
              ExecSandbox.select({ ...req, mechanism: Sandbox.None() }, host)

              const expectedExitCodes = expectNonZero ? [0, 1, 2] : [0]
              const runExit = yield* Effect.exit(
                Exec.run(
                  { workspaceRoot: tmpRoot },
                  {
                    cwd: ".",
                    argv: [process.execPath, "-e", `process.stdout.write("ok:${exitCode}"); process.exit(${exitCode})`],
                    env: {},
                    secrets: [],
                    expectedExitCodes,
                    timeoutMs: 10_000
                  }
                )
              )
              const shouldSucceed = expectedExitCodes.includes(exitCode)
              if (shouldSucceed) {
                if (runExit._tag !== "Success") throw new Error("exec run failed: " + JSON.stringify(runExit.cause))
                if (runExit.value.exitCode !== exitCode) throw new Error("exitCode mismatch")
                if (!runExit.value.stdout.includes(`ok:${exitCode}`)) throw new Error("stdout mismatch")
              } else {
                if (runExit._tag !== "Failure") throw new Error("exec run should have failed")
              }
              return true
            }),
          { executions: fsExecutions, seed: seed + 10 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it("SecretProxy vault, authority parsing, HttpProxyPolicy & live local HTTP proxy redaction/audience invariants", async () => {
    const upstream = NodeHttp.createServer((req, res) => {
      const auth = req.headers["authorization"] ?? ""
      res.writeHead(200, { "content-type": "text/plain", "x-echo-auth": String(auth) })
      res.end(`upstream-ok:${req.url ?? "/"}:${String(auth)}`)
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const addr = upstream.address()
    if (!addr || typeof addr === "string") throw new Error("no upstream port")
    const origin = `http://127.0.0.1:${addr.port}`

    const secretVal = "super-secret-fuzz-token-99999"
    const vault = SecretProxy.makeVault({
      read: (name) =>
        name === "FUZZ_TOKEN"
          ? secretVal
          : name === "FUZZ_DEST"
          ? `${origin}/secret-path`
          : name === "FUZZ_BAD_DEST"
          ? `http://user:pass@127.0.0.1:${addr.port}/leak`
          : undefined
    })
    const cred = Secret.HttpCredential.make({ secret: Secret.Secret("FUZZ_TOKEN"), audiences: [origin] })
    const placeholder = vault.mint(cred)
    const proxy = await SecretProxy.startProxy(vault)
    const brokeredOrigin = await proxy.originFor(origin)

    const httpGet = (url: string, headers: Record<string, string> = {}) =>
      new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
        const req = NodeHttp.get(url, { headers }, (res) => {
          const chunks: Array<Buffer> = []
          res.on("data", (c: Buffer) => chunks.push(c))
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
        })
        req.on("error", reject)
      })

    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          authority: Schema.Literals([
            "api.github.com:443",
            "[::1]:8443",
            "localhost:80",
            "bad-no-port",
            "host:99999",
            "host:0",
            ":443",
            ""
          ]),
          connHeader: Schema.Literals(["keep-alive, x-custom", "close", ""]),
          reqPath: Schema.Literals(["/v1/items", "/v1/echo?a=1", "/health"]),
          mode: Schema.Literals(["allowed", "cred-dest", "missing-secret", "dest-url"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ authority, connHeader, reqPath, mode }) =>
            Effect.gen(function*() {
              const parsed = SecretProxy.parseConnectAuthority(authority)
              const expectValid = authority === "api.github.com:443" ||
                authority === "[::1]:8443" ||
                authority === "localhost:80"
              if (expectValid && parsed === undefined) return false
              if (!expectValid && parsed !== undefined) return false
              if (parsed !== undefined && (parsed.port < 1 || parsed.port > 65535)) return false

              const conns = HttpProxyPolicy.connectionHeaderNames(connHeader || undefined)
              if (connHeader.includes("x-custom") && !conns.has("x-custom")) return false
              if (HttpProxyPolicy.upstreamFailure({ code: "ECONNREFUSED" }).length === 0) return false
              if (HttpProxyPolicy.destinationPort(new URL("https://example.com")) !== 443) return false
              if (HttpProxyPolicy.destinationPort(new URL("http://example.com:8080")) !== "8080") return false
              if (HttpProxyPolicy.requestTarget(undefined) !== "") return false
              if (HttpProxyPolicy.upstreamStatus(undefined) !== 502) return false
              if (HttpProxyPolicy.unrepresentableRequest(["SECRET"]).length === 0) return false
              const bt = HttpProxyPolicy.brokeredTarget(origin, reqPath)
              if (!(bt instanceof URL)) return false

              const uploadState = { bytes: 0, rejected: false }
              const chunks: Array<Uint8Array> = []
              HttpProxyPolicy.appendUploadChunk(uploadState, chunks, new Uint8Array([1, 2, 3]), 10)
              if (uploadState.bytes !== 3 || uploadState.rejected) return false
              HttpProxyPolicy.appendUploadChunk(uploadState, chunks, new Uint8Array(20), 10)
              if (!uploadState.rejected) return false

              if (mode === "cred-dest") {
                const ans = yield* Effect.promise(() => httpGet(proxy.urlFor(Secret.Secret("FUZZ_BAD_DEST"))))
                if (ans.status !== 400 || ans.body.includes("pass")) return false
              } else if (mode === "missing-secret") {
                const ans = yield* Effect.promise(() => httpGet(proxy.urlFor(Secret.Secret("NO_SUCH_SECRET"))))
                if (ans.status < 400) return false
              } else if (mode === "dest-url") {
                const ans = yield* Effect.promise(() => httpGet(proxy.urlFor(Secret.Secret("FUZZ_DEST"))))
                if (ans.status !== 200 || ans.body.includes(secretVal)) return false
              } else {
                const ans = yield* Effect.promise(() =>
                  httpGet(`${brokeredOrigin}${reqPath}`, { authorization: `Bearer ${placeholder}` })
                )
                if (ans.status !== 200 || ans.body.includes(secretVal)) return false
              }
              return true
            }),
          { executions: fsExecutions, seed: seed + 11 }
        )
      )
      assertPassed(report)
    } finally {
      await proxy.close()
      await new Promise<void>((resolve) => {
        upstream.closeAllConnections()
        upstream.close(() => resolve())
      })
    }
  })

  it("ReviewBatches, LlmLint.review (in-memory transport + snapshot), SecurityReview, JevLint & PrivateStore fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-review-")))
    const storeDir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-store-")))
    try {
      await Fs.mkdir(NodePath.join(tmpRoot, "src"), { recursive: true })
      await Fs.writeFile(NodePath.join(tmpRoot, "src/a.ts"), "import { b } from './b.ts'\nexport const a = b + 1\n")
      await Fs.writeFile(NodePath.join(tmpRoot, "src/b.ts"), "export const b = 42\n")

      const arb = Arbitrary.schema(
        Schema.Struct({
          fileCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
          failOn: Schema.Literals(["info", "warning", "error"]),
          emitFinding: Schema.Boolean,
          findingSeverity: Schema.Literals(["info", "warning", "error"]),
          jevProb: Schema.Literals([0.1, 0.5, 0.95]),
          securityMode: Schema.Boolean,
          secretToken: Schema.Literals([
            "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "plain"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ fileCount, failOn, emitFinding, findingSeverity, jevProb, securityMode, secretToken }) =>
            Effect.gen(function*() {
              const srcA = "import { b } from './b'\nexport const x = b + 1\n"
              const srcB = "export const b = 2\n"
              if (ReviewBatches.estimateTokens(srcA) <= 0) return false
              if (!ReviewBatches.isScript("src/a.ts") || ReviewBatches.isScript("README.md")) return false
              const specs = ReviewBatches.importSpecifiers(srcA)
              if (!specs.includes("./b")) return false
              const cands = ReviewBatches.importCandidates("src/a.ts", "./b")
              if (cands.length === 0) return false
              const resolved = ReviewBatches.resolveImport("src/a.ts", "./b", (p) => p === "src/b.ts")
              if (resolved !== "src/b.ts") return false
              if (ReviewBatches.importStems("src/b.ts").length === 0) return false
              if (ReviewBatches.goPackage("pkg/foo/bar.go") !== "pkg/foo") return false
              const split = ReviewBatches.splitFile(
                { path: "src/big.ts", contents: "a\n".repeat(40) },
                20,
                (seg) => ReviewBatches.estimateTokens(seg.contents)
              )
              if (split.length < 1) return false

              const changed: Array<LlmLint.SnapshotFile> = Array.from({ length: fileCount }, (_, i) => ({
                path: `src/f${i}.ts`,
                contents: `import { b } from './b'\nexport const v${i} = b + ${i}\n`,
                changed: true
              }))
              const batches = ReviewBatches.planBatches({
                files: changed,
                edges: new Map(),
                related: new Map(),
                relatedCost: () => 10,
                segmentCost: (seg) => ReviewBatches.estimateTokens(seg.contents),
                budget: 4000,
                maximumFiles: 2
              })
              if (batches.length === 0) return false
              ReviewBatches.calleePaths(changed, (p) => p === "src/b.ts")
              ReviewBatches.callerPatterns(changed.map((c) => c.path))
              ReviewBatches.goDirectories(["cmd/a/main.go"])
              ReviewBatches.relate(
                changed,
                [{ path: "src/b.ts", contents: srcB }],
                (p) => p === "src/b.ts"
              )

              ReviewEnvironment.spawnEnvironment(
                [],
                true,
                tmpRoot,
                "claude",
                process.env,
                process.platform,
                NodePath.join
              )
              const redacted = LlmLint.redactCredentials(`error with ${secretToken} leaked`)
              if (secretToken !== "plain" && redacted.includes(secretToken)) return false
              if (LlmLint.engineExecutable("claude").length === 0) return false
              if (LlmLint.engineExecutable("codex").length === 0) return false
              LlmLint.relatedCandidates(changed, new Set(["src/b.ts"]))

              const findingsJson = emitFinding
                ? [{
                  file: "src/f0.ts",
                  line: 1,
                  severity: findingSeverity,
                  message: "Fuzz finding",
                  ...(securityMode ? { checkId: "general", impact: "high", category: "injection" } : {})
                }]
                : []
              const answerText = securityMode
                ? JSON.stringify({
                  status: "completed",
                  coverage: [{ checkId: "general", status: "completed", evidence: "Inspected all files." }],
                  missingContext: [],
                  findings: findingsJson
                })
                : JSON.stringify(findingsJson)

              const transport: LlmLint.ReviewTransport = (seat) =>
                Effect.succeed({
                  modelId: `resolved/${seat.model}`,
                  model: Model.make({
                    stream: () =>
                      Stream.fromIterable([
                        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "t", text: answerText }),
                        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
                      ])
                  })
                })

              const reviewExit = yield* Effect.exit(
                LlmLint.review(
                  {
                    workspaceRoot: tmpRoot,
                    snapshot: changed,
                    revisions: { base: "a".repeat(40), head: "b".repeat(40) },
                    transport,
                    store: { directory: storeDir, owner: "fuzz" }
                  },
                  {
                    base: "HEAD",
                    include: [Input.glob("src/**")],
                    context: [],
                    prompt: "Review these files.",
                    rubric: SecurityReview.renderRubric([SecurityReview.generalCheck]),
                    engine: "claude",
                    model: "claude-opus-5-5",
                    batchSize: 8,
                    failOn,
                    ...(securityMode ? { securityChecks: ["general"] } : {})
                  }
                )
              )

              const sevRank = (s: "info" | "warning" | "error") => (s === "info" ? 0 : s === "warning" ? 1 : 2)
              const expectFail = emitFinding && sevRank(findingSeverity) >= sevRank(failOn)
              if (expectFail && reviewExit._tag !== "Failure") throw new Error("expected review failure")
              if (!expectFail && reviewExit._tag !== "Success") {
                throw new Error("unexpected review failure: " + JSON.stringify(reviewExit.cause))
              }

              const stored = yield* LlmLint.storedFindings(storeDir)
              for (const rec of stored) {
                const pub = LlmLint.publicSummary(rec)
                if (pub.fingerprint !== rec.fingerprint) return false
              }
              const recKey = `probe/${"a".repeat(64)}.json`
              PrivateStore.write(storeDir, recKey, { ok: true })
              const readBack = PrivateStore.read(storeDir, recKey)
              if (readBack === undefined) throw new Error("privStore readBack")
              const listed = PrivateStore.list(storeDir, "probe")
              if (listed.length === 0) throw new Error("privStore listed")

              const secTargets = SecurityReview.SecurityReview({
                cwd: ".",
                include: [Input.glob("src/**/*.ts")],
                checks: [{
                  ...SecurityReview.generalCheck,
                  id: "fuzz-auth"
                }]
              })
              if (!Target.isTarget(secTargets.security) || !Target.isTarget(secTargets.securityAudit)) return false
              if (plannedCalls(secTargets.security).length === 0) return false
              const confirmed = SecurityReview.confirmFinding(
                {
                  file: "src/a.ts",
                  line: 1,
                  severity: "error",
                  message: "bug",
                  security: {
                    checkId: "general",
                    impact: "high",
                    verification: "suspected",
                    releaseRecommendation: "block",
                    attackerPreconditions: "none",
                    evidence: "input",
                    nextConfirmationStep: "run test"
                  }
                },
                { revision: "a".repeat(40), command: "pnpm test", observedResult: "reproduced" }
              )
              if (confirmed.security?.reproduction?.revision !== "a".repeat(40)) return false

              const jevTarget = JevLint.JevLint({
                rules: [{
                  id: "no-todo",
                  files: [Input.glob("src/**/*.ts")],
                  lookFor: "TODO comments",
                  violation: "Has TODO",
                  compliant: "No TODO",
                  severity: "error"
                }]
              })
              if (!Target.isTarget(jevTarget) || plannedCalls(jevTarget).length === 0) return false

              const jevJudge = Evaluator.layerScripted((req) =>
                Object.fromEntries(Object.keys(req.questions).map((id) => [id, { probability: jevProb }]))
              )
              const jevExit = yield* Effect.exit(
                JevLint.review(
                  { workspaceRoot: tmpRoot, judge: jevJudge },
                  {
                    rules: [{
                      id: "no-todo",
                      files: [Input.glob("src/**/*.ts")],
                      lookFor: "TODO comments",
                      violation: "Has TODO",
                      compliant: "No TODO",
                      severity: "error"
                    }],
                    threshold: 0.8,
                    failOn: "error",
                    model: "typesafe-ai/jev"
                  }
                )
              )
              if (jevProb >= 0.8 && jevExit._tag !== "Failure") throw new Error("jev expected failure")
              if (jevProb < 0.8 && jevExit._tag !== "Success") {
                throw new Error("jev unexpected failure: " + JSON.stringify(jevExit.cause))
              }
              return true
            }),
          { executions: fsExecutions, seed: seed + 12 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
      await Fs.rm(storeDir, { recursive: true, force: true })
    }
  })

  it("ToolBuild output measurement/verification, Compose wrappers/generators, Filegroup & JobKeeper pure helpers fuzz invariants", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-tb-")))
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          fileCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
          tamper: Schema.Boolean,
          exclusive: Schema.Boolean,
          pidA: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 999 })),
          pidB: Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 9999 })),
          subDir: Schema.Literals(["out", "dist/nested", "artifacts/sub"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ fileCount, tamper, exclusive, pidA, pidB, subDir }) =>
            Effect.gen(function*() {
              const outDir = NodePath.join(tmpRoot, subDir)
              yield* Effect.promise(() => Fs.rm(outDir, { recursive: true, force: true }))
              yield* Effect.promise(() => Fs.mkdir(outDir, { recursive: true }))
              for (let i = 0; i < fileCount; i++) {
                yield* Effect.promise(() => Fs.writeFile(NodePath.join(outDir, `f${i}.txt`), `content-${i}\n`, "utf8"))
              }

              const measured = yield* Effect.promise(() => ToolBuild.measureOutput(tmpRoot, ".", subDir))
              if (measured.fileCount !== fileCount) throw new Error("measured.fileCount")
              const outputs = yield* Effect.promise(() => ToolBuild.measureOutputs(tmpRoot, ".", [subDir]))
              if (outputs.outputs.length !== 1) throw new Error("outputs.length")

              const declared = { cwd: ".", paths: [subDir] }
              const manifest = ToolBuild.readOutputManifest(declared, outputs)
              if (typeof manifest === "string" || manifest.outputs.length !== 1) {
                throw new Error("manifest: " + String(manifest))
              }

              if (tamper) {
                yield* Effect.promise(() => Fs.writeFile(NodePath.join(outDir, "f0.txt"), "TAMPERED\n", "utf8"))
                const mismatch = yield* Effect.promise(() => ToolBuild.verifyOutputs(tmpRoot, declared, manifest))
                if (mismatch === undefined) throw new Error("tamper not detected")
              } else {
                const ok = yield* Effect.promise(() => ToolBuild.verifyOutputs(tmpRoot, declared, manifest))
                if (ok !== undefined) throw new Error("verify failed: " + ok)
              }

              const tbTarget = ToolBuild.ToolBuild({
                tool: "gen",
                command: "gen",
                args: ["--out", subDir],
                inputs: [Input.file("src/in.ts")],
                outputs: [subDir],
                deps: [],
                env: {},
                cache: true
              })
              if (!Target.isTarget(tbTarget) || plannedCalls(tbTarget).length === 0) throw new Error("tbTarget")

              const ctx: Target.ImplementationContext = { sourceFile: "/ws/PACKAGE.ts", packageDirectory: "" }
              const fg = Filegroup.Filegroup({ srcs: [Input.glob(`${subDir}/*.txt`)] })
              if (!Filegroup.isFilegroup(fg)) throw new Error("isFilegroup")
              if (Filegroup.sources(Target.metadata(fg).attrs as Filegroup.Attrs, ctx).length !== 1) {
                throw new Error("fg sources")
              }
              const expanded = yield* Effect.promise(() =>
                Filegroup.expand(tmpRoot, [Input.glob(`${subDir}/*.txt`)])
              )
              if (expanded.length !== fileCount) throw new Error("fg expand: " + expanded.length)

              const baseCmd = Shell.Test({ shell: "true" })
              const alias = Compose.Alias(baseCmd)
              const suite = Compose.Suite(exclusive ? { tests: [baseCmd], exclusive: true } : { tests: [baseCmd] })
              const mat = Compose.Materialize(baseCmd)
              const clean = Compose.Clean({ targets: [baseCmd], paths: [subDir] })
              const gen = Compose.Generate({
                emit: { [`${subDir}/gen.txt`]: "hello\n" },
                mode: "write"
              })
              const ic = Compose.ImportClosure({ entries: [Input.file(`${subDir}/f0.txt`)] })
              if (!Compose.isImportClosure(ic)) throw new Error("isImportClosure")
              if (
                Compose.closureEntrySources(
                  (Target.metadata(ic).attrs as typeof Compose.ImportClosureAttrs.Type).entries,
                  ctx
                ).length === 0
              ) {
                throw new Error("closureEntrySources")
              }
              if (Target.isExclusive(Target.metadata(suite).attrs) !== exclusive) throw new Error("isExclusive")
              if (
                plannedCalls(alias).length === 0 ||
                plannedCalls(suite).length === 0 ||
                plannedCalls(mat).length === 0 ||
                plannedCalls(clean).length === 0 ||
                plannedCalls(gen).length === 0
              ) {
                throw new Error("plannedCalls empty")
              }

              const kCmd = JobKeeper.keeper(process.execPath)
              if (kCmd[0] !== process.execPath || kCmd[1] !== "-e") throw new Error("kCmd: " + JSON.stringify(kCmd))
              const cCmd = JobKeeper.client(process.execPath, tmpRoot, ["echo", "hi"])
              if (!cCmd.includes(process.execPath) || !cCmd.includes("--")) throw new Error("cCmd: " + JSON.stringify(cCmd))
              const nsCmd = JobKeeper.namespaced("/usr/bin/bwrap", ["--ro-bind", "/usr", "/usr"], kCmd)
              if (nsCmd[0] !== "/usr/bin/bwrap" || !nsCmd.includes("--unshare-pid")) {
                throw new Error("nsCmd: " + JSON.stringify(nsCmd))
              }

              const leftText = JSON.stringify([
                { pid: pidA, command: "node worker" },
                { pid: pidB, command: "sleep 10" }
              ])
              const left = JobKeeper.leftIn(leftText)
              if (left.length !== 2 || left[0]!.pid !== pidA || left[1]!.pid !== pidB) {
                throw new Error("leftIn mismatch: " + JSON.stringify(left))
              }
              if (JobKeeper.leftIn("not-json").length !== 0) throw new Error("leftIn invalid")
              if (JobKeeper.leftIn(undefined).length !== 0) throw new Error("leftIn undef")

              const lsofText = `p${pidA}\nfcwd\nn/tmp/a\np${pidB}\nfcwd\nn/tmp/b\n`
              const cwds = JobKeeper.cwdsFromLsof(lsofText)
              if (cwds.get(pidA) !== "/tmp/a" || cwds.get(pidB) !== "/tmp/b") {
                throw new Error("cwds mismatch: " + JSON.stringify([...cwds]))
              }

              const leftFile = NodePath.join(tmpRoot, "left.txt")
              yield* Effect.promise(() => Fs.writeFile(leftFile, leftText, "utf8"))
              const leftRead = yield* Effect.promise(() => JobKeeper.leftAt(leftFile))
              if (leftRead.length !== 2) throw new Error("leftAt mismatch")
              return true
            }),
          { executions: fsExecutions, seed: seed + 13 }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  })
})
