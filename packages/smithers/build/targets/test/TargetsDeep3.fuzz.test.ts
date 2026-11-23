import { Fuzz } from "@smthrs/fuzz"
import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Arbitrary, Effect, Exit, PlatformError, Schema } from "effect"
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import type * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Factory from "../src/Factory.ts"
import * as Flow from "../src/Flow.ts"
import * as FlowCatalog from "../src/FlowCatalog.ts"
import * as Home from "../src/Home.ts"
import * as Input from "../src/Input.ts"
import { Process } from "../src/internal/Process.ts"
import { SandboxHost } from "../src/internal/SandboxHost.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as Secret from "../src/Secret.ts"
import * as SecurityReview from "../src/SecurityReview.ts"
import * as Target from "../src/Target.ts"
import { plannedCalls } from "./plan.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261125")
const fsExecutions = Math.min(executions, 14)

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const gitRun = (cwd: string, ...args: ReadonlyArray<string>): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
      { cwd, encoding: "utf8" },
      (err) => (err === null ? resolve() : reject(err))
    )
  })

const claudeEnvelope = (findings: string): string => JSON.stringify({ type: "result", result: findings })

const codexEnvelope = (findings: string): string =>
  [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking" } }),
    JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: findings } }),
    JSON.stringify({ type: "turn.completed", usage: { output_tokens: 12 } }),
    ""
  ].join("\n")

const makeFakeEngineCli = async (dir: string, name: string, stdout: string, exitCode = 0, stderr = ""): Promise<string> => {
  const p = NodePath.join(dir, `${name}.mjs`)
  await Fs.writeFile(
    p,
    `#!${process.execPath}\n` +
      "for await (const _ of process.stdin) {}\n" +
      `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});\n` +
      `process.stdout.write(${JSON.stringify(stdout)});\n` +
      `process.exit(${exitCode});\n`,
    "utf8"
  )
  await Fs.chmod(p, 0o755)
  return p
}

describe("@smthrs/targets deep fuzz suite 3: LlmLint, SecurityReview, Exec & Factory", () => {
  it("LlmLint real git + fake claude/codex CLI execution, security mode, store/closeFinding, redaction & SecurityReview boundaries", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-llmlint-")))
    try {
      const repo = NodePath.join(tmpRoot, "repo")
      const binDir = NodePath.join(tmpRoot, "bin")
      await Fs.mkdir(NodePath.join(repo, "packages/app/src/upload"), { recursive: true })
      await Fs.mkdir(NodePath.join(repo, "packages/app/src/client"), { recursive: true })
      await Fs.mkdir(NodePath.join(repo, "shared/auth"), { recursive: true })
      await Fs.mkdir(NodePath.join(repo, "shared/storage"), { recursive: true })
      await Fs.mkdir(binDir, { recursive: true })

      await Fs.writeFile(NodePath.join(repo, "packages/app/src/upload/handler.ts"), "export const upload = (p: string) => p\n", "utf8")
      await Fs.writeFile(NodePath.join(repo, "packages/app/src/upload/deleted.ts"), "export const gone = 1\n", "utf8")
      await Fs.writeFile(NodePath.join(repo, "packages/app/src/client/ui.ts"), "export const ui = 1\n", "utf8")
      await Fs.writeFile(NodePath.join(repo, "shared/auth/check.ts"), "export const auth = () => true\n", "utf8")
      await Fs.writeFile(NodePath.join(repo, "shared/storage/put.ts"), "export const put = () => true\n", "utf8")
      await Fs.writeFile(NodePath.join(repo, "packages/app/README.md"), "# App context\n", "utf8")

      await gitRun(repo, "init", "--initial-branch=main")
      await gitRun(repo, "add", ".")
      await gitRun(repo, "commit", "-m", "base")

      // Mutate, add, and delete files so git diff exercises all paths
      await Fs.writeFile(
        NodePath.join(repo, "packages/app/src/upload/handler.ts"),
        "import { auth } from \"../../../../shared/auth/check.ts\"\nexport const upload = (p: string) => auth() ? p : \"\"\n",
        "utf8"
      )
      await Fs.writeFile(NodePath.join(repo, "packages/app/src/upload/added.ts"), "export const added = 2\n", "utf8")
      await Fs.unlink(NodePath.join(repo, "packages/app/src/upload/deleted.ts"))

      const arb = Arbitrary.schema(
        Schema.Struct({
          engine: Schema.Literals(["claude", "codex"]),
          scope: Schema.Literals(["changed", "all"]),
          outcome: Schema.Literals(["clean", "warning", "error", "malformed", "nonzero", "missing-cli", "security-ok"]),
          failOn: Schema.Literals(["error", "warning", "info"]),
          credPattern: Schema.Literals([
            "api_key=\"sk_live_abc1234567890\"",
            "Authorization: Bearer tok_secret_99999999",
            "password: mySuperSecretPassword123",
            "credentials: \"include\"",
            "token = \"${ENV_TOKEN}\"",
            "SECRET_KEY=plain_value_abc12345"
          ])
        })
      )

      let caseIdx = 0
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ engine, scope, outcome, failOn, credPattern }) =>
            Effect.gen(function*() {
              const idx = caseIdx++
              // 1. Credential redaction patterns
              const redacted = LlmLint.redactCredentials(`log line: ${credPattern}`)
              if (typeof redacted !== "string") throw new Error("redacted string")
              if (credPattern.includes("sk_live_") && redacted.includes("sk_live_")) {
                throw new Error("failed to redact sk_live_")
              }
              void redacted
              if (credPattern.includes("credentials: \"include\"") && !redacted.includes("include")) {
                throw new Error("credential mode should not be over-redacted")
              }

              // 2. Build fake CLI script for this outcome
              const findingPayload =
                outcome === "clean"
                  ? "[]"
                  : outcome === "warning"
                  ? JSON.stringify([{ file: "packages/app/src/upload/handler.ts", line: 1, severity: "warning", message: "warn msg" }])
                  : outcome === "error"
                  ? JSON.stringify([{ file: "packages/app/src/upload/handler.ts", line: 1, severity: "error", message: "err msg" }])
                  : outcome === "security-ok"
                  ? JSON.stringify([
                    {
                      file: "packages/app/src/upload/handler.ts",
                      line: 2,
                      severity: "error",
                      message: "path traversal risk",
                      check: "upload-path",
                      impact: "high",
                      evidence: {
                        source: "request param",
                        sink: "upload return",
                        why: "no validation"
                      }
                    }
                  ])
                  : "not valid json {{"

              const stdout = engine === "claude" ? claudeEnvelope(findingPayload) : codexEnvelope(findingPayload)
              const cliPath =
                outcome === "missing-cli"
                  ? NodePath.join(binDir, `definitely-missing-${idx}`)
                  : yield* Effect.promise(() =>
                    makeFakeEngineCli(
                      binDir,
                      `cli-${idx}`,
                      outcome === "nonzero" ? "" : stdout,
                      outcome === "nonzero" ? 1 : 0,
                      outcome === "nonzero" ? "cli failed with token=sk_secret_12345" : ""
                    )
                  )

              const storeDir = NodePath.join(tmpRoot, `store-${idx}`)
              const reviewPayload: LlmLint.Payload = {
                base: "HEAD",
                scope,
                include: [Input.glob("packages/app/src/upload/**/*.ts")],
                context: [Input.glob("packages/app/README.md")],
                prompt: "Review these files.",
                rubric: "Check correctness and security.",
                engine,
                model: engine === "claude" ? "claude-opus-5-5" : "gpt-6-sol",
                batchSize: 4,
                failOn,
                ...(outcome === "security-ok"
                  ? {
                    securityChecks: ["upload-path", "general"],
                    alternateModel: engine === "claude" ? "gpt-6-sol" : "claude-opus-5-5"
                  }
                  : {})
              }

              const exit = yield* LlmLint.review(
                {
                  workspaceRoot: repo,
                  executable: cliPath,
                  store: { directory: storeDir, owner: "fuzz" },
                  timeoutMs: 30_000
                },
                reviewPayload
              ).pipe(Effect.exit)

              if (outcome === "missing-cli" || outcome === "nonzero" || outcome === "malformed") {
                if (!Exit.isFailure(exit)) throw new Error(`expected failure for ${outcome}`)
                // Exercise publicError & publicAttempts
                const err = new LlmLint.LlmReviewError({ phase: "review", message: "failed with api_key=\"sk_secret_1234567890\"" })
                const pubErr = LlmLint.publicError(err)
                if (pubErr.message.includes("sk_secret_")) throw new Error("publicError leaked secret")
                const pubAtt = LlmLint.publicAttempts([
                  { engine, model: "m", status: "failed", message: "token=sk_secret_1234567890" } as never
                ])
                if (!Array.isArray(pubAtt)) throw new Error("publicAttempts")
              } else if (outcome === "clean") {
                if (Exit.isFailure(exit)) throw new Error(`expected clean success, got: ${JSON.stringify(exit.cause)}`)
              } else if (outcome === "warning") {
                const shouldFail = failOn === "warning" || failOn === "info"
                if (Exit.isFailure(exit) !== shouldFail) {
                  throw new Error(`warning with failOn=${failOn}: failed=${Exit.isFailure(exit)}`)
                }
              } else if (outcome === "error") {
                const shouldFail = true
                if (Exit.isFailure(exit) !== shouldFail) {
                  throw new Error(`error with failOn=${failOn}: failed=${Exit.isFailure(exit)}`)
                }
              } else if (outcome === "security-ok") {
                const stored = yield* LlmLint.storedFindings(storeDir)
                for (const rec of stored) {
                  const summary = LlmLint.publicSummary(rec)
                  if (summary.fingerprint !== rec.fingerprint) throw new Error("publicSummary fingerprint")
                  yield* LlmLint.closeFinding(storeDir, rec.fingerprint, { revision: "rev1", command: "test", observedResult: "ok" }).pipe(Effect.exit)
                }
              }

              // 3. LlmLint target & SecurityReview with boundaries + path validation
              const check: SecurityReview.Check = {
                id: "upload-path",
                title: "Upload stays in root",
                threat: "Path traversal outside root.",
                lookFor: ["Unvalidated path join"],
                paths: ["src/upload/**"]
              }
              const boundary: SecurityReview.Boundary = {
                id: "upload-boundary",
                actors: ["User"],
                assets: ["Files"],
                entryPoints: ["HTTP POST"],
                identityTransformations: ["Cookie to user"],
                enforcementPoints: ["auth()"],
                deploymentAssumptions: ["Single tenant"],
                path: {
                  caller: ["src/client/**"],
                  authorization: ["//shared/auth/**"],
                  service: ["src/upload/**"],
                  storageOrEgress: ["//shared/storage/**"]
                }
              }
              const secTargets = SecurityReview.SecurityReview({
                cwd: "packages/app",
                workspaceRoot: repo,
                checks: [check],
                boundaries: [boundary],
                include: ["src/upload/**", Input.glob("src/client/**"), "//shared/auth/**"],
                context: ["README.md"],
                engine,
                batchSize: 4,
                auditBatchSize: 8
              })
              const calls = plannedCalls(secTargets.security)
              if (calls.length === 0) throw new Error("secTargets calls")

              // Invalid boundary/check paths must throw
              let threwBadPath = false
              try {
                SecurityReview.SecurityReview({
                  cwd: "packages/app",
                  workspaceRoot: repo,
                  checks: [{ ...check, paths: ["src/does-not-exist/**"] }]
                })
              } catch {
                threwBadPath = true
              }
              if (!threwBadPath) throw new Error("expected bad check path throw")

              let threwBadId = false
              try {
                SecurityReview.SecurityReview({ cwd: "packages/app", checks: [{ ...check, id: "BAD ID!" }] })
              } catch {
                threwBadId = true
              }
              if (!threwBadId) throw new Error("expected bad check id throw")

              // LlmReviewLive layer construction
              const liveLayer = LlmLint.LlmReviewLive({ workspaceRoot: repo })
              if (liveLayer === undefined) throw new Error("LlmReviewLive")

              return true
            }),
          { executions: fsExecutions, seed }
        )
      )
      assertPassed(report)
    } finally {
      await Fs.rm(tmpRoot, { recursive: true, force: true })
    }
  }, 120_000)

  it("Exec deep execution: outputLimit truncation, timeout, cache-dir token, secrets+destinations, StartupRetry, win32 path/spawnShape & payload validation", async () => {
    const tmpRoot = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-execdeep-")))
    const outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-targets-execout-")))
    const upstream = NodeHttp.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(`AUTH=${req.headers["authorization"] ?? ""}`)
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
    const upAddr = upstream.address() as NodeNet.AddressInfo

    try {
      await Fs.mkdir(NodePath.join(tmpRoot, "bin"), { recursive: true })
      await Fs.writeFile(NodePath.join(tmpRoot, "bin/tool.cmd"), "@echo hi\r\n", "utf8")
      await Fs.writeFile(NodePath.join(tmpRoot, "bin/tool.exe"), "mz", "utf8")
      await Fs.chmod(NodePath.join(tmpRoot, "bin/tool.cmd"), 0o755)
      await Fs.chmod(NodePath.join(tmpRoot, "bin/tool.exe"), 0o755)
      await Fs.symlink(outside, NodePath.join(tmpRoot, "escape-cache"))

      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "large-output",
            "timeout",
            "cache-dir-ok",
            "cache-dir-escape",
            "secret-http",
            "startup-retry-ok",
            "startup-retry-fail",
            "expected-exit-match",
            "expected-exit-mismatch",
            "invalid-payload"
          ]),
          winArg: Schema.Literals(["plain", "with space", "a\"b", "a%b", "a&b"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, winArg }) =>
            Effect.gen(function*() {
              // 1. Windows spawnShape & findAllOnPath / findOnPath
              const winBinDir = NodePath.join(tmpRoot, "bin")
              const foundAll = Exec.findAllOnPath("tool", { PATH: winBinDir, PATHEXT: ".cmd;.exe" }, { platform: "win32" })
              if (foundAll.length === 0) throw new Error("win32 findAllOnPath")
              const foundOne = Exec.findOnPath("tool", { PATH: winBinDir, PATHEXT: ".cmd;.exe" }, { platform: "win32" })
              if (foundOne === undefined) throw new Error("win32 findOnPath")

              const cmdPath = NodePath.join(winBinDir, "tool.cmd")
              if (winArg.includes("\"") || winArg.includes("%")) {
                let threw = false
                try {
                  Exec.spawnShape([cmdPath, winArg], { platform: "win32", env: { PATH: winBinDir } })
                } catch {
                  threw = true
                }
                if (!threw) throw new Error("expected unencodable win32 cmd arg throw")
              } else {
                const shape = Exec.spawnShape([cmdPath, winArg], { platform: "win32", env: { PATH: winBinDir } })
                if (shape.file.length === 0) throw new Error("win32 spawnShape")
              }

              // 2. Exec.run modes
              const basePayload = (argv: [string, ...Array<string>], extra: Partial<Exec.Payload> = {}): Exec.Payload => ({
                cwd: ".",
                argv,
                env: {},
                secrets: [],
                expectedExitCodes: [0],
                timeoutMs: 30_000,
                ...extra
              })

              if (mode === "large-output") {
                const res = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  basePayload([
                    process.execPath,
                    "-e",
                    "const chunk = \"A\".repeat(32768); for (let i = 0; i < 8; i++) { process.stdout.write(chunk); process.stderr.write(chunk); }"
                  ])
                )
                if (res.stdout.length > Exec.outputLimit + 200) throw new Error("stdout exceeded limit")
              } else if (mode === "timeout") {
                const exit = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  basePayload([process.execPath, "-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 80 })
                ).pipe(Effect.exit)
                if (!Exit.isFailure(exit)) throw new Error("expected timeout failure")
              } else if (mode === "cache-dir-ok") {
                const res = yield* Exec.run(
                  { workspaceRoot: tmpRoot, cacheDirectory: ".flows-test" },
                  basePayload([process.execPath, "-e", "process.stdout.write(process.argv[1])", Exec.cacheDirectoryToken])
                )
                if (!res.stdout.includes(".flows-test")) throw new Error(`cache dir not expanded: ${res.stdout}`)
              } else if (mode === "cache-dir-escape") {
                const exit = yield* Exec.run(
                  { workspaceRoot: tmpRoot, cacheDirectory: "escape-cache" },
                  basePayload([process.execPath, "-e", "0", Exec.cacheDirectoryToken])
                ).pipe(Effect.exit)
                if (!Exit.isFailure(exit)) throw new Error("expected symlink escape cache-dir failure")
              } else if (mode === "secret-http") {
                const origin = `http://127.0.0.1:${upAddr.port}`
                const sec = Secret.Secret("EXEC_FUZZ_TOKEN")
                const cred = Secret.HttpSecret(sec, [origin])
                const res = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  basePayload(
                    [
                      process.execPath,
                      "-e",
                      "process.stdout.write(String(process.env.EXEC_FUZZ_TOKEN ?? \"\"))",
                      `${origin}/check`
                    ],
                    {
                      secrets: [cred]
                    }
                  )
                ).pipe(Effect.exit)
                void Exec.unservableAudiences({ argv: [], env: {}, secrets: [cred] })
                void res
              } else if (mode === "startup-retry-ok") {
                let attempts = 0
                const res = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  basePayload([process.execPath, "-e", "process.stdout.write(\"ok\")"])
                ).pipe(
                  Effect.provideService(Exec.StartupRetry, { attemptsMs: [1000, 1000, 1000], backoffMs: 1 }),
                  Effect.provideService(Process, {
                    spawn: (opts) => {
                      attempts++
                      return ScopedProcess.spawn(attempts === 1 ? { ...opts, startupTimeoutMs: 1 } : opts)
                    },
                    status: ScopedProcess.status
                  })
                )
                if (res.stdout !== "ok" || attempts < 2) throw new Error("expected retry success")
              } else if (mode === "startup-retry-fail") {
                const exit = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  basePayload([process.execPath, "-e", "0"])
                ).pipe(
                  Effect.provideService(Exec.StartupRetry, { attemptsMs: [1000, 1000], backoffMs: 1 }),
                  Effect.provideService(Process, {
                    spawn: () =>
                      Effect.fail(
                        PlatformError.systemError({
                          _tag: "NotFound",
                          module: "ChildProcess",
                          method: "spawn",
                          cause: Object.assign(new Error("ENOENT"), { code: "ENOENT" })
                        })
                      ),
                    status: ScopedProcess.status
                  }),
                  Effect.exit
                )
                if (!Exit.isFailure(exit)) throw new Error("expected permanent ENOENT failure")
              } else if (mode === "expected-exit-match") {
                const res = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  basePayload([process.execPath, "-e", "process.exit(3)"], { expectedExitCodes: [3] })
                )
                if (res.exitCode !== 3) throw new Error("expected exitCode 3")
              } else if (mode === "expected-exit-mismatch") {
                const exit = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  basePayload([process.execPath, "-e", "process.exit(4)"], { expectedExitCodes: [0] })
                ).pipe(Effect.exit)
                if (!Exit.isFailure(exit)) throw new Error("expected exit mismatch failure")
              } else {
                // Invalid payloads rejected cleanly
                for (const bad of [
                  null,
                  { cwd: ".", argv: [], env: {}, secrets: [], expectedExitCodes: [0], timeoutMs: 1000 },
                  { cwd: "../escape", argv: ["true"], env: {}, secrets: [], expectedExitCodes: [0], timeoutMs: 1000 },
                  { cwd: ".", argv: ["a\u0000b"], env: {}, secrets: [], expectedExitCodes: [0], timeoutMs: 1000 },
                  { cwd: ".", argv: ["true"], env: {}, secrets: [], expectedExitCodes: [0], timeoutMs: -1 },
                  { cwd: ".", argv: ["true"], env: {}, secrets: [], expectedExitCodes: [0], timeoutMs: 1000, extra: 1 }
                ]) {
                  const exit = yield* Exec.run({ workspaceRoot: tmpRoot }, bad as never).pipe(Effect.exit)
                  if (!Exit.isFailure(exit)) throw new Error("expected invalid payload failure")
                }
                // SandboxHost error path
                const sbExit = yield* Exec.run(
                  { workspaceRoot: tmpRoot },
                  basePayload([process.execPath, "-e", "0"], { sandbox: { network: false } } as never)
                ).pipe(
                  Effect.provideService(SandboxHost, {
                    platform: "win32",
                    bwrap: undefined,
                    docker: undefined
                  } as never),
                  Effect.exit
                )
                void sbExit
              }

              // ExecLive layer check
              const live = Exec.ExecLive({ workspaceRoot: tmpRoot })
              if (live === undefined) throw new Error("ExecLive")
              return true
            }),
          { executions: fsExecutions, seed: seed + 1 }
        )
      )
      assertPassed(report)
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await Fs.rm(tmpRoot, { recursive: true, force: true })
      await Fs.rm(outside, { recursive: true, force: true })
    }
  }, 120_000)

  it("Factory declarations, GithubPolicy, machines, issueViews, issueTransitions, lifecycle, rules, renderProjection & parseProjection fuzz invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mirror: Schema.Literals(["push", "pull", "none"]),
        issues: Schema.Literals(["read", "two-way", "none"]),
        changes: Schema.Literals(["land", "send-upstream", "none"]),
        mode: Schema.Literals(["write", "check"]),
        vcpus: Schema.Literals([2, 8, 0, 2000]),
        memMiB: Schema.Literals([2048, 8192, -1]),
        badSummary: Schema.Boolean,
        withViews: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mirror, issues, changes, mode, vcpus, memMiB, badSummary, withViews }) =>
          Effect.sync(() => {
            const viewBlocks = [Home.Text({ title: "Status", text: "Running fine." })]
            const reviewFlow = Flow.Flow({
              flow: "review",
              summary: "Review changes.",
              featured: true,
              ...(withViews ? { view: viewBlocks as unknown as FlowCatalog.Row["view"] } : { view: undefined })
            })
            const lintFlow = Flow.Flow({ flow: "lint", summary: "Lint files." })
            const catalog: ReadonlyArray<FlowCatalog.Row> = [
              withViews
                ? {
                    id: "review",
                    description: "Review",
                    summary: "Review changes.",
                    featured: true,
                    kind: "mdx",
                    path: "flows/review/flow.mdx",
                    capabilities: ["fs:read:**"],
                    model: null,
                    modelInvocable: true,
                    view: viewBlocks as unknown as FlowCatalog.Row["view"]
                  }
                : {
                    id: "review",
                    description: "Review",
                    summary: "Review changes.",
                    featured: true,
                    kind: "mdx",
                    path: "flows/review/flow.mdx",
                    capabilities: ["fs:read:**"],
                    model: null,
                    modelInvocable: true
                  },
              {
                id: "lint",
                description: "Lint",
                summary: "Lint files.",
                featured: false,
                kind: "ts",
                path: "flows/lint/flow.ts",
                capabilities: [],
                model: null,
                modelInvocable: true
              }
            ]

            // 1. Policy validation (valid vs invalid combos)
            let policy: Factory.GithubPolicy | undefined
            try {
              policy = Factory.Policy({ mirror, issues, changes })
            } catch {
              policy = undefined
            }

            // 2. Machine validation
            const validMachine = vcpus > 0 && vcpus <= 1024 && memMiB > 0
            if (badSummary) {
              let threw = false
              try {
                Factory.Factory({ summary: "<script>alert(1)</script>" })
              } catch {
                threw = true
              }
              if (!threw) throw new Error("expected HTML summary rejection")
              return true
            }

            const factoryOpts: Factory.FactoryOptions = {
              summary: "A clean factory summary.",
              flows: [reviewFlow, lintFlow],
              ...(policy !== undefined ? { github: policy } : {}),
              on: {
                "pr.opened": "review",
                "push:main": ["review", "lint"],
                "schedule:0 * * * *": {
                  flow: "lint",
                  payload: { scope: "all" }
                }
              },
              machine: {
                vcpus,
                memoryMiB: memMiB,
                tools: ["node", "git"]
              },
              issueViews: [
                { id: "open", title: "Open", labels: ["bug"] }
              ],
              issueTransitions: [
                { id: "close-bug", title: "Close", from: "open", to: "closed", actor: "anyone" }
              ]
            }

            if (!validMachine) {
              let threw = false
              try {
                Factory.Factory(factoryOpts)
              } catch {
                threw = true
              }
              if (!threw) throw new Error("expected invalid machine rejection")
              return true
            }

            const decl = Factory.Factory(factoryOpts)
            if (!Factory.isFactoryDeclaration(decl)) throw new Error("isFactoryDeclaration")
            const rs = Factory.rules(decl)
            if (rs.length < 3) throw new Error("expected rules")

            const rendered = Factory.renderProjection(decl, catalog)
            const parsed = Factory.parseProjection(rendered)
            if (typeof parsed === "string") throw new Error(`parseProjection failed: ${parsed}`)
            if (typeof Factory.parseProjection("{bad json") !== "string") throw new Error("expected parse error")
            if (typeof Factory.parseProjection("{}") !== "string") throw new Error("expected schema parse error")

            // FactoryProjection target planning
            const proj = Factory.FactoryProjection({ mode })
            const calls = plannedCalls(proj)
            if (calls.length === 0) throw new Error("FactoryProjection calls")
            return true
          }),
        { executions, seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})
