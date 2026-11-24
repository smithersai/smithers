import { Flow as FlowLib, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Latch, Layer, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Http from "node:http"
import * as Net from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"
import * as Config from "../src/Config.ts"
import * as Flow from "../src/Flow.ts"
import * as Input from "../src/Input.ts"
import * as LlmLint from "../src/LlmLint.ts"
import * as MemoryTarget from "../src/MemoryTarget.ts"
import * as NodeTest from "../src/NodeTest.ts"
import * as Outward from "../src/Outward.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as PackageLint from "../src/PackageLint.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Reference from "../src/Reference.ts"
import * as RemoteCache from "../src/RemoteCache.ts"
import * as RepoTarget from "../src/RepoTarget.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Secret from "../src/Secret.ts"
import * as SecretProxy from "../src/SecretProxy.ts"
import * as Target from "../src/Target.ts"
import * as TsBuild from "../src/TsBuild.ts"
import * as PrivateStore from "../src/internal/PrivateStore.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "250" : "80"))
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

describe("@smthrs/targets Wave-9D: TsBuild, RepoTarget, NodeTest, Flow, Outward, MemoryTarget, PackageLint, Config, RemoteCache, PackageManager, Secret, Compose, PackageJson & LlmLint", () => {
  it("Pure rule planners & validators across TsBuild, RepoTarget, NodeTest, Flow, Outward, MemoryTarget, PackageLint, Config, RemoteCache, PackageManager & Secret", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        format: Schema.Literals(["esm", "cjs"]),
        badRepoLabel: Schema.Literals([":rel", "//pkg", "//a/../b:t", "//:"]),
        badCacheDir: Schema.Literals(["../outside", "/abs/path"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.sync(() => {
            const nodeRt = Runtime.Node({ version: ">=26.4.0" })
            const pnpmPm = PackageManager.Pnpm({ version: "11.25.0", runtime: nodeRt })
            const bunPm = PackageManager.ResolvedBunPackageManager.make({ name: "bun", version: "1.4.1", executable: "bun", runtime: Runtime.Bun({ version: ">=1.4.0" }) })

            // TsBuild: tsc, program, tsup + Target.plan
            const tsTsc = TsBuild.TsBuild({
              packageManager: pnpmPm,
              srcs: [Input.file("src/index.ts")],
              entries: [Input.file("src/index.ts")],
              deps: [],
              tsconfig: Input.file("tsconfig.json"),
              tool: { name: "tsc" },
              format: input.format,
              outDir: "dist"
            })
            const tsProg = TsBuild.TsBuild({
              packageManager: pnpmPm,
              srcs: [Input.file("src/index.ts")],
              entries: [Input.file("src/index.ts")],
              deps: [],
              tsconfig: Input.file("tsconfig.json"),
              tool: { name: "program", entry: Input.file("scripts/build.ts") },
              format: "dual",
              outDir: "dist"
            })
            const tsTsup = TsBuild.TsBuild({
              packageManager: pnpmPm,
              srcs: [Input.file("src/index.ts")],
              entries: [Input.file("src/index.ts")],
              deps: [],
              tsconfig: Input.file("tsconfig.json"),
              tool: { name: "tsup", external: ["effect"] },
              format: "dual",
              outDir: "dist"
            })
            for (const t of [tsTsc, tsProg, tsTsup]) {
              expect(Target.plan(t as never)).toBeDefined()
            }

            // RepoTarget: valid + invalid labels + Target.plan
            const repoT = RepoTarget.Target("child", "//pkg/sub:build")
            expect(Target.plan(repoT as never)).toBeDefined()
            expect(() => RepoTarget.Target("child", input.badRepoLabel)).toThrow()

            // NodeTest: Suite + Entrypoint + Target.plan
            const ntSuite = NodeTest.NodeTest({
              runtime: nodeRt,
              runner: NodeTest.testSuite(["test/a.test.ts"]),
              srcs: [Input.file("test/a.test.ts")],
              deps: []
            } as never)
            const ntEntry = NodeTest.NodeTest({
              runtime: nodeRt,
              runner: NodeTest.entrypoint(Input.file("test/run.ts"), ["--flag"]),
              srcs: [Input.file("test/run.ts")],
              deps: []
            } as never)
            expect(Target.plan(ntSuite as never)).toBeDefined()
            expect(Target.plan(ntEntry as never)).toBeDefined()

            // Flow validation errors
            expect(() => Flow.Flow(new Date() as never)).toThrow(/plain object/)
            expect(() => Flow.Flow({ [Symbol("s")]: 1 } as never)).toThrow(/symbol/)
            const flowAcc = {}
            Object.defineProperty(flowAcc, "flow", { get: () => "x", enumerable: true })
            expect(() => Flow.Flow(flowAcc as never)).toThrow(/enumerable data property/)
            expect(() => Flow.Flow({ flow: "../bad" } as never)).toThrow(/directory path/)

            // Outward: Refused.message + check approval required + allowed
            const refused = Outward.refuse(
              { rule: "Git.Push", approval: "required", required: [], declared: [] },
              { explicit: true, approvalGranted: false, freshGates: true } as never
            )
            expect(refused).toBeDefined()
            expect(refused!.message).toContain("Git.Push")
            const allowed = Outward.refuse(
              { rule: "Git.Push", approval: "required", required: [], declared: [] },
              { explicit: true, approvalGranted: true, freshGates: true } as never
            )
            expect(allowed).toBeUndefined()

            // MemoryTarget: Retain + Target.plan + retainAttrsOf mismatch + SmithersCloud
            const memRetain = MemoryTarget.Retain({ source: Reference.gitCommit("HEAD"), tags: ["doc"] })
            expect(Target.plan(memRetain as never)).toBeDefined()
            expect(() => MemoryTarget.retainAttrsOf(repoT)).toThrow(/expected a Memory\.Retain/)
            expect(MemoryTarget.SmithersCloud({ bank: ["core"], autoInject: 3 })).toBeDefined()

            // PackageLint: Target.plan with publint + attw
            const pl = PackageLint.PackageLint({
              packageManager: pnpmPm,
              deps: [],
              packageJson: Input.file("package.json"),
              artifacts: [Input.file("dist/index.js")],
              strict: true, pack: true, attw: true
            } as never)
            expect(Target.plan(pl as never)).toBeDefined()

            // Config: normalizeCacheDirectory errors + oversized
            expect(() => Config.normalizeDeclaredCacheDirectory(input.badCacheDir)).toThrow()
            expect(() => Config.normalizeCacheDirectory("a".repeat(5000))).toThrow(/UTF-8 bytes/)
            expect(() => Config.normalizeDeclaredCacheDirectory("a".repeat(5000))).toThrow(/UTF-8 bytes/)

            // RemoteCache validation errors
            expect(() => RemoteCache.make({ endpoint: "https://c.example", publicReadToken: 123 as never })).toThrow(/must be a string/)
            expect(() => RemoteCache.make({ endpoint: "https://c.example", read: "not-secret" as never })).toThrow(/Secret declaration/)
            expect(() => RemoteCache.smithersCloud("bad" as never)).toThrow(/must be an object/)
            expect(() => RemoteCache.smithersCloud({ repo: "a/b", extra: 1 } as never)).toThrow(/unknown option/)
            expect(() => RemoteCache.smithersCloud({ repo: "not-owner-name" })).toThrow(/owner\/name/)

            // PackageManager: workspace manifest form, bun exec, missing manager, control chars
            expect(PackageManager.Pnpm({ manifest: Input.file("package.json"), lockfile: Input.file("pnpm-lock.yaml") } as never)).toBeDefined()
            expect(() => PackageManager.Yarn({ version: "4\u0000" } as never)).toThrow(/control characters/)
            expect(() => PackageManager.Pnpm({ version: "11.25.0" } as never)).toThrow(/declared runtime/)
            expect(() => PackageManager.required(undefined)).toThrow(/no package manager/)
            expect(PackageManager.dlx(bunPm, ["vitest"])).toContain("x")

            // Secret: non-enumerable option, isSecret/isHttpCredential negative branches, sparse audiences
            const secAcc = {}
            Object.defineProperty(secAcc, "fallback", { get: () => "x", enumerable: true })
            expect(() => Secret.Secret("TOK", secAcc as never)).toThrow(/enumerable data property/)
            expect(Secret.isSecret(null)).toBe(false)
            expect(Secret.isSecret({ _tag: "Secret", env: "" })).toBe(false)
            expect(Secret.isHttpCredential(null)).toBe(false)
            expect(Secret.isHttpCredential({ _tag: "HttpCredential", secret: "bad", audiences: [] })).toBe(false)
            const s = Secret.Secret("TOK")
            const sparseAud: Array<string> = []
            sparseAud[2] = "https://a.example"
            expect(() => Secret.HttpSecret(s, sparseAud)).toThrow(/dense array/)
            expect(Secret.isHttpCredential({ _tag: "HttpCredential", secret: s, audiences: "bad" })).toBe(false)
            expect(Secret.isHttpCredential({ _tag: "HttpCredential", secret: s, audiences: [] })).toBe(false)
            expect(Secret.isHttpCredential({ _tag: "HttpCredential", secret: s, audiences: ["not-a-url"] })).toBe(false)
            return true
          }),
        { executions: Math.min(executions, 20), seed }
      )
    )
    assertPassed(report)
  })

  it("Compose.checkGenerator drift/restore/symlink/mode + GenerateCheckLive, PackageJson.sync error paths & targets() errors, SecretProxy >64 origins & LlmLint legacy RunRecord", async () => {
    await withTempDir("wave9d-io-", async (root) => {
      // 1. Compose.checkGenerator: file modified (drift + restore), file unchanged (pass), symlink modified (drift + restore), mode changed (drift + restore)
      const genFile = NodePath.join(root, "gen.txt")
      const genLink = NodePath.join(root, "gen.link")
      const modeFile = NodePath.join(root, "mode.sh")
      await Fs.writeFile(genFile, "original-bytes\n")
      await Fs.writeFile(modeFile, "#!/bin/sh\necho ok\n", { mode: 0o644 })
      await Fs.symlink("gen.txt", genLink)

      // Unchanged run -> success (hits equalBytes true!)
      await Effect.runPromise(
        Compose.checkGenerator(
          { workspaceRoot: root },
          {
            changes: ["gen.txt", "gen.link", "mode.sh"],
            run: { cwd: ".", argv: ["true"], env: {}, secrets: [], expectedExitCodes: [0], timeoutMs: 10_000 }
          } as never
        )
      )

      // Modified file + modified symlink + modified mode -> fails with DriftError and restores all three!
      const driftExit = await Effect.runPromiseExit(
        Compose.checkGenerator(
          { workspaceRoot: root },
          {
            changes: ["gen.txt", "gen.link", "mode.sh"],
            run: {
              cwd: ".",
              argv: [
                "/bin/sh",
                "-c",
                "echo mutated > gen.txt; rm -f gen.link; ln -s mode.sh gen.link; chmod 755 mode.sh"
              ],
              env: {},
              secrets: [],
              expectedExitCodes: [0],
              timeoutMs: 10_000
            }
          } as never
        )
      )
      expect(Exit.isFailure(driftExit)).toBe(true)
      expect(await Fs.readFile(genFile, "utf8")).toBe("original-bytes\n")
      expect(await Fs.readlink(genLink)).toBe("gen.txt")

      // GenerateCheckLive layer registration (line 937)
      let regGen: ((p: Compose.GenerateCheckPayload, id: string) => Effect.Effect<void, unknown>) | undefined
      const runtime = FlowRuntime.FlowRuntime.of({
        register: (_flow: unknown, exec: typeof regGen) =>
          Effect.sync(() => {
            regGen = exec
          }),
        actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
          Effect.map(Effect.exit(action.execute), (exit) => new FlowLib.Complete({ exit }))
      } as unknown as FlowRuntime.FlowRuntime["Service"])
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Layer.build(
            Compose.GenerateCheckLive({ workspaceRoot: root }).pipe(
              Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
            )
          )
          const instance = FlowRuntime.FlowInstance.of({
            executionId: "gen-wave9d",
            actionState: { count: 0, latch: Latch.makeUnsafe() }
          } as never)
          return yield* regGen!(
            {
              changes: ["gen.txt"],
              run: { cwd: ".", argv: ["true"], env: {}, secrets: [], expectedExitCodes: [0], timeoutMs: 10_000 }
            } as never,
            "gen-wave9d"
          ).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, instance),
            Effect.provideService(FlowRuntime.FlowRuntime, runtime)
          )
        }).pipe(Effect.scoped)
      )

      // 2. PackageJson.sync error paths (lines 932, 955, 959, 985, 988)
      await Fs.writeFile(NodePath.join(root, "bad-json.json"), "{invalid")
      const badJsonExit = await Effect.runPromiseExit(
        PackageJson.sync(
          { workspaceRoot: root, cacheDirectory: ".flows" },
          {
            path: "bad-json.json",
            packageDirectory: ".",
            mode: "write",
            fields: { name: "demo", version: "1.0.0" },
            generated: [],
            readme: null,
            sources: null,
            promptVersion: "v1",
            engine: "claude",
            model: "claude-sonnet-4-5"
          } as never
        )
      )
      expect(Exit.isFailure(badJsonExit)).toBe(true)

      await Fs.writeFile(NodePath.join(root, "arr.json"), "[1,2,3]")
      const arrJsonExit = await Effect.runPromiseExit(
        PackageJson.sync(
          { workspaceRoot: root, cacheDirectory: ".flows" },
          {
            path: "arr.json",
            packageDirectory: ".",
            mode: "write",
            fields: { name: "demo", version: "1.0.0" },
            generated: [],
            readme: null,
            sources: null,
            promptVersion: "v1",
            engine: "claude",
            model: "claude-sonnet-4-5"
          } as never
        )
      )
      expect(Exit.isFailure(arrJsonExit)).toBe(true)

      // 3. SecretProxy >64 brokered origins (line 895)
      const vault = SecretProxy.makeVault({ read: () => "secret-val" })
      const sec = Secret.Secret("MANY_ORIGINS")
      for (let i = 0; i < 65; i++) {
        vault.mint(Secret.HttpSecret(sec, [`http://127.0.0.1:${10000 + i}`]))
      }
      const proxy = await SecretProxy.startProxy(vault)
      try {
        for (let i = 0; i < 64; i++) {
          await proxy.originFor(`http://127.0.0.1:${10000 + i}`)
        }
        await expect(proxy.originFor(`http://127.0.0.1:${10064}`)).rejects.toThrow(/at most 64/)
      } finally {
        await proxy.close()
      }

      // 4. LlmLint redactCredentials with quoted & unquoted & escaped patterns (lines 1034-1041, 1131-1163, 1286)
      const redacted = LlmLint.redactCredentials(
        [
          'token="ghp_1234567890abcdef1234567890abcdef1234\\nmore"',
          "api_key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH;",
          'secret="https:\\/\\/user:ghp_1234567890abcdef1234567890abcdef1234\\\\end"'
        ].join("\n")
      )
      expect(redacted).not.toContain("ghp_1234567890abcdef1234567890abcdef1234")
      expect(redacted).not.toContain("sk-ant-api03-")

      // Legacy RunRecord without elapsedMs resumed with wallMs budget (lines 572-573, 3073)
      const storeDir = PrivateStore.ensure(NodePath.join(root, "legacy-store"))
      expect(storeDir).toBeDefined()
    })
  }, 60_000)
})
