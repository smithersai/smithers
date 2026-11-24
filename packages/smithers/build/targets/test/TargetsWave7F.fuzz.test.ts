import { Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Latch, Layer, Schema } from "effect"
import * as NodeChildProcess from "node:child_process"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as DocsCheck from "../src/DocsCheck.ts"
import * as Exec from "../src/Exec.ts"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as Secret from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as ToolBuild from "../src/ToolBuild.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 8)
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const withTempDir = async <A>(prefix: string, fn: (dir: string) => Promise<A>): Promise<A> => {
  const dir = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  try {
    return await fn(dir)
  } finally {
    await Fs.rm(dir, { recursive: true, force: true })
  }
}

const gitExec = (root: string, args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile("git", ["-C", root, ...args], (err, stdout) => {
      if (err !== null) reject(err)
      else resolve(stdout.trim())
    })
  })

const runCaptureLive = (
  options: { readonly workspaceRoot: string; readonly cacheDirectory?: string | undefined },
  payload: ToolBuild.CapturePayload
) => {
  type Reg = (p: ToolBuild.CapturePayload, id: string) => Effect.Effect<ToolBuild.Outputs, ToolBuild.OutputError>
  let registered: Reg | undefined
  const runtime = FlowRuntime.FlowRuntime.of({
    register: (_flow: unknown, execute: Reg) => Effect.sync(() => { registered = execute }),
    actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
      Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
  } as unknown as FlowRuntime.FlowRuntime["Service"])
  return Effect.scoped(Effect.gen(function*() {
    yield* Layer.build(
      ToolBuild.CaptureOutputsLive(options).pipe(
        Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
      )
    )
    const instance = FlowRuntime.FlowInstance.of({
      executionId: "cap-wave7f",
      actionState: { count: 0, latch: Latch.makeUnsafe() }
    } as never)
    return yield* registered!(payload, "cap-wave7f").pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provideService(FlowRuntime.FlowRuntime, runtime)
    )
  }))
}

describe("@smthrs/targets Wave-7F: Secret, Cargo rules, DocsCheck stamps/evidence, ToolBuild CaptureOutputsLive, Exec live proxy/streaming & LlmLint deep paths", () => {
  it("Secret constructors, normalizeAudience, Cargo rule declarations/validation & DocsCheck stamp/evidence lifecycle cover all branches", async () => {
    // Secret valid & invalid
    const s = Secret.Secret("MY_TOKEN", { fallback: "fallback-val" })
    expect(Secret.isSecret(s)).toBe(true)
    const hs = Secret.HttpSecret(s, ["https://api.example.com", "http://127.0.0.1:8080"])
    expect(Secret.isHttpCredential(hs)).toBe(true)
    expect(Secret.SecretOrigin("https://api.example.com")).toContain("https://api.example.com")

    const secretBad: ReadonlyArray<() => unknown> = [
      () => Secret.Secret(""),
      () => Secret.Secret("9BAD!"),
      () => Secret.Secret("A".repeat(300)),
      () => Secret.Secret("OK", { fallback: 123 as never }),
      () => Secret.Secret("OK", { fallback: "x".repeat(Secret.maximumFallbackLength + 10) }),
      () => Secret.Secret("OK", { fallback: "\uD800" }),
      () => Secret.Secret("OK", null as never),
      () => Secret.Secret("OK", { [Symbol("s")]: 1 } as never),
      () => Secret.Secret("OK", { extra: 1 } as never),
      () => Secret.Secret("OK", { allowInUrl: "yes" as never }),
      () => Secret.Secret(123 as never),
      () => Secret.normalizeAudience(""),
      () => Secret.normalizeAudience("not-a-url"),
      () => Secret.normalizeAudience("ftp://example.com"),
      () => Secret.normalizeAudience("https://user:pass@example.com"),
      () => Secret.normalizeAudience("https://example.com/path"),
      () => Secret.normalizeAudience("https://example.com?q=1"),
      () => Secret.normalizeAudience("https://example.com#frag"),
      () => Secret.HttpSecret({} as never, ["https://a.example"]),
      () => Secret.HttpSecret(s, []),
      () => Secret.HttpSecret(s, Array.from({ length: 40 }, (_, i) => `https://a${i}.example`)),
    ]
    for (const fn of secretBad) expect(() => fn()).toThrow()

    // Cargo rule declarations & selector errors
    const validCargoTargets = [
      Cargo.Fetch({}),
      Cargo.Build({ workspace: true, allFeatures: true }),
      Cargo.Test({ package: "demo" }),
      Cargo.Nextest({ package: "demo" }),
      Cargo.Deny({ config: Input.file("deny.toml") }),
      Cargo.Clippy({ workspace: true }),
      Cargo.Fmt({}),
      Cargo.Doc({ package: "demo" }),
      Cargo.AppSet({ manifests: [Input.glob("Cargo.toml")] })
    ]
    for (const t of validCargoTargets) {
      expect(Target.isTarget(t)).toBe(true)
    }
    expect(() => Cargo.Build({} as never)).toThrow()
    expect(() => Cargo.Build({ workspace: true, package: "demo" } as never)).toThrow()
    expect(() => Cargo.Build({ workspace: true, features: ["a"], allFeatures: true } as never)).toThrow()

    // DocsCheck stamp & evidence lifecycle
    const now = Date.now()
    const freshEv = JSON.stringify({ format: 1, dependency: "//:dep", observedAt: now - 1000, digest: "a".repeat(64) })
    const staleEv = JSON.stringify({ format: 1, dependency: "//:dep", observedAt: now - 999_999_999, digest: "a".repeat(64) })
    expect(DocsCheck.evidenceDigest(freshEv, { file: Input.file("ev.json"), dependency: "//:dep", ttlMs: 60_000 }, now)).toMatch(/^[0-9a-f]{64}$/)
    expect(DocsCheck.evidenceDigest(staleEv, { file: Input.file("ev.json"), dependency: "//:dep", ttlMs: 60_000 }, now)).toBeUndefined()
    expect(DocsCheck.evidenceDigest("not-json", { file: Input.file("ev.json"), dependency: "//:dep", ttlMs: 60_000 }, now)).toBeUndefined()
    expect(DocsCheck.evidenceDigest(undefined, { file: Input.file("ev.json"), dependency: "//:dep", ttlMs: 60_000 }, now)).toBeUndefined()

    const stamp = DocsCheck.makeStamp({
      producer: "//:gen",
      output: { path: "docs/a.md", digest: "b".repeat(64) },
      inputs: [{ path: "src/a.ts", digest: "c".repeat(64) }]
    })
    const rendered = DocsCheck.renderStamp(stamp)
    expect(DocsCheck.parseStamp(rendered)).toBeDefined()
    expect(DocsCheck.parseStamp("not json")).toBeUndefined()
    expect(DocsCheck.parseStamp(JSON.stringify({ version: 999 }))).toBeUndefined()

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: secretBad.length - 1 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            expect(() => secretBad[idx]!()).toThrow()
            return true
          }),
        { executions: Math.max(executions, 30), seed }
      )
    )
    assertPassed(report)
  })

  it("Exec.run executes real subprocesses with SecretProxy brokered origin, stdout/stderr streaming, sensitiveEnv validation & ToolBuild.CaptureOutputsLive", async () => {
    const upstream = Http.createServer((req, res) => {
      const auth = String(req.headers["authorization"] ?? "")
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(auth === "Bearer real-exec-secret" ? "AUTH_OK" : `AUTH_BAD:${auth}`)
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const addr = upstream.address() as { readonly port: number }
    const origin = `http://127.0.0.1:${addr.port}`

    const origEnv = process.env["WAVE7_EXEC_SECRET"]
    process.env["WAVE7_EXEC_SECRET"] = "real-exec-secret"
    try {
      await withTempDir("smthrs-t7f-exec-", async (root) => {
        const chunksOut: Array<string> = []
        const chunksErr: Array<string> = []

        // 1) Happy path with SecretProxy + S.SecretOrigin + onStdout/onStderr
        const res = await Effect.runPromise(
          Exec.run(
            {
              workspaceRoot: root,
              onStdout: (c) => chunksOut.push(Buffer.from(c).toString("utf8")),
              onStderr: (c) => chunksErr.push(Buffer.from(c).toString("utf8"))
            },
            {
              cwd: ".",
              argv: [
                process.execPath,
                "-e",
                `fetch(process.argv[1] + "/check", { headers: { authorization: "Bearer " + process.env.WAVE7_EXEC_SECRET } }).then(r => r.text()).then(t => { process.stdout.write(t); process.stderr.write("err-note"); })`,
                Secret.SecretOrigin(origin)
              ],
              env: {},
              expectedExitCodes: [0],
              secrets: [Secret.HttpSecret(Secret.Secret("WAVE7_EXEC_SECRET"), [origin])],
              timeoutMs: 10_000
            }
          )
        )
        expect(res.exitCode).toBe(0)
        expect(res.stdout).toContain("AUTH_OK")
        expect(chunksOut.join("")).toContain("AUTH_OK")
        expect(chunksErr.join("")).toContain("err-note")

        // 2) Invalid sensitiveEnv names
        const badSens = await Effect.runPromise(
          Effect.exit(
            Exec.run(
              { workspaceRoot: root, sensitiveEnv: ["9BAD!"] },
              { cwd: ".", argv: [process.execPath, "-e", "0"], env: {}, expectedExitCodes: [0], secrets: [], timeoutMs: 5_000 }
            )
          )
        )
        expect(Exit.isFailure(badSens)).toBe(true)

        // 3) Unexpected exit code
        const badExit = await Effect.runPromise(
          Effect.exit(
            Exec.run(
              { workspaceRoot: root },
              { cwd: ".", argv: [process.execPath, "-e", "process.exit(7)"], env: {}, expectedExitCodes: [0], secrets: [], timeoutMs: 5_000 }
            )
          )
        )
        expect(Exit.isFailure(badExit)).toBe(true)

        // 4) ToolBuild.CaptureOutputsLive happy + error + cache overlap + single file
        await Fs.mkdir(NodePath.join(root, "out"), { recursive: true })
        await Fs.writeFile(NodePath.join(root, "out", "f.txt"), "hello")
        await Fs.writeFile(NodePath.join(root, "single.txt"), "one")
        const capOk = await Effect.runPromise(
          runCaptureLive({ workspaceRoot: root, cacheDirectory: ".cache" }, { cwd: ".", paths: ["out", "single.txt"] })
        )
        expect(capOk.outputs.length).toBe(2)

        const capOverlap = await Effect.runPromise(
          Effect.exit(
            runCaptureLive({ workspaceRoot: root, cacheDirectory: ".cache" }, { cwd: ".", paths: [".cache"] })
          )
        )
        expect(Exit.isFailure(capOverlap)).toBe(true)

        const capMissing = await Effect.runPromise(
          Effect.exit(
            runCaptureLive({ workspaceRoot: root }, { cwd: ".", paths: ["does-not-exist"] })
          )
        )
        expect(Exit.isFailure(capMissing)).toBe(true)
      })
    } finally {
      if (origEnv === undefined) delete process.env["WAVE7_EXEC_SECRET"]
      else process.env["WAVE7_EXEC_SECRET"] = origEnv
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  }, 30_000)

  it("LlmLint legacy RunRecord, closeFinding, Go sibling discovery, ByteCapture growth, invalid-UTF8 TailCapture & PackageJson field cache cover deep paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        cacheCase: Schema.Literals(["valid-hit", "corrupt-json", "wrong-ver", "excess-key", "wrong-digest"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ cacheCase }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-t7f-llm-", async (root) => {
              // 1) PackageJson field cache test
              await Fs.writeFile(NodePath.join(root, "README.md"), "# Demo\n\nA nice package.\n")
              await Fs.writeFile(
                NodePath.join(root, "package.json"),
                JSON.stringify({ name: "@smthrs/demo", version: "1.0.0", description: "Cached desc", keywords: ["demo"] }, null, 2) + "\n"
              )
              const syncPayload: PackageJson.SyncPayload = {
                mode: "check",
                path: "package.json",
                fields: { name: "@smthrs/demo", version: "1.0.0" },
                generated: ["description", "keywords"],
                model: "openai/gpt-5-mini",
                engine: "claude",
                promptVersion: "1",
                sources: null,
                readme: Input.file("README.md")
              }
              const ctx = await PackageJson.generationContext(root, syncPayload)
              const hash = createHash("sha256")
                .update("smithers-build-package-json-field-cache/1\0")
                .update(`${Buffer.byteLength("package.json", "utf8")}:`, "utf8")
                .update("package.json", "utf8")
                .update(ctx.digest, "ascii")
                .digest("hex")
              const cacheFile = NodePath.join(root, ".flows", "package-json-fields", `${hash}.json`)
              await Fs.mkdir(NodePath.dirname(cacheFile), { recursive: true })
              const content = cacheCase === "valid-hit"
                ? JSON.stringify({ version: 1, contextDigest: ctx.digest, fields: { description: "Cached desc", keywords: ["demo"] } })
                : cacheCase === "corrupt-json"
                ? "{bad-json"
                : cacheCase === "wrong-ver"
                ? JSON.stringify({ version: 2, contextDigest: ctx.digest, fields: {} })
                : cacheCase === "excess-key"
                ? JSON.stringify({ version: 1, contextDigest: ctx.digest, fields: {}, extra: 1 })
                : JSON.stringify({ version: 1, contextDigest: "wrong", fields: {} })
              await Fs.writeFile(cacheFile, content)
              // Mode check reads cache & compares with checked-in package.json
              await Effect.runPromise(
                PackageJson.sync({ workspaceRoot: root, cacheDirectory: ".flows" }, syncPayload)
              )
            })
            return true
          }),
        { executions: Math.max(fsExecutions, 8), seed: seed + 1 }
      )
    )
    assertPassed(report)

    // 2) LlmLint real git repo with Go siblings, ByteCapture growth, invalid UTF-8 stderr ring wrap & legacy RunRecord
    await withTempDir("smthrs-t7f-git-", async (root) => {
      await gitExec(root, ["init", "-q"])
      await gitExec(root, ["config", "user.email", "test@example.com"])
      await gitExec(root, ["config", "user.name", "Test"])
      await Fs.mkdir(NodePath.join(root, "pkg"), { recursive: true })
      await Fs.writeFile(NodePath.join(root, "pkg", "a.go"), "package pkg\nfunc A() int { return 1 }\n")
      await Fs.writeFile(NodePath.join(root, "pkg", "b.go"), "package pkg\nfunc B() int { return A() }\n")
      await gitExec(root, ["add", "."])
      await gitExec(root, ["commit", "-q", "-m", "init"])
      await Fs.writeFile(NodePath.join(root, "pkg", "a.go"), "package pkg\nfunc A() int { return 2 }\n")

      // Fake claude CLI that emits >32KB stdout (grows ByteCapture) and >70KB invalid UTF-8 stderr (wraps TailCapture)
      const binDir = NodePath.join(root, "fakebin")
      await Fs.mkdir(binDir, { recursive: true })
      const claudeStub = NodePath.join(binDir, "claude")
      await Fs.writeFile(
        claudeStub,
        `#!${process.execPath}
const bad = Buffer.alloc(70000, 0xff);
process.stderr.write(bad);
const pad = " ".repeat(40000);
process.stdout.write(JSON.stringify({ result: "[]" + pad }));
`,
        { mode: 0o755 }
      )

      const origPath = process.env["PATH"]
      process.env["PATH"] = `${binDir}:${origPath ?? ""}`
      try {
        // Context glob matching 0 files -> LlmReviewError
        const emptyCtx = await Effect.runPromise(
          Effect.exit(
            LlmLint.review(
              { workspaceRoot: root, sensitiveEnv: [], executable: claudeStub },
              {
                engine: "claude",
                model: "claude-sonnet-4-6",
                prompt: "Check code",
                scope: "changed",
                base: "HEAD",
                failOn: "error",
                context: [Input.glob("nonexistent/**/*.md")],
                include: [Input.glob("pkg/**/*.go")],
                rubric: "Check code",
                batchSize: 10
              }
            )
          )
        )
        expect(Exit.isFailure(emptyCtx)).toBe(true)

        // Valid run exercising Go sibling discovery + ByteCapture buffer growth + invalid UTF-8 TailCapture wrap
        const rep = await Effect.runPromise(
          LlmLint.review(
            { workspaceRoot: root, sensitiveEnv: [], executable: claudeStub },
            {
              engine: "claude",
              model: "claude-sonnet-4-6",
              prompt: "Check code",
              scope: "changed",
              base: "HEAD",
              failOn: "error",
              context: [],
              include: [Input.glob("pkg/**/*.go")],
              rubric: "Check code",
              batchSize: 10
            }
          )
        )
        expect(rep.findings.length).toBe(0)
      } finally {
        process.env["PATH"] = origPath
      }

      // Legacy RunRecord without elapsedMs + closeFinding on missing fingerprint
      const storeDir = NodePath.join(root, ".findings")
      await Fs.mkdir(NodePath.join(storeDir, "runs"), { recursive: true })
      await Fs.writeFile(
        NodePath.join(storeDir, "runs", "legacy.json"),
        JSON.stringify({
          id: "legacy",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:01.000Z",
          engine: "claude",
          model: "claude-sonnet-4-6",
          scope: "changed",
          files: ["pkg/a.go"],
          findings: 0,
          usage: { inputTokens: 10, outputTokens: 5, batches: 1, calls: 1 }
        })
      )
      const stored = await Effect.runPromise(LlmLint.storedFindings(storeDir))
      expect(stored.length).toBe(0)
      const closeMissing = await Effect.runPromise(
        Effect.exit(LlmLint.closeFinding(storeDir, "nonexistent-fp", { revision: "r1", command: "test", observedResult: "fixed" }))
      )
      expect(Exit.isFailure(closeMissing)).toBe(true)
    })
  }, 30_000)
})
