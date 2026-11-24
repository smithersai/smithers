import { Fuzz } from "@smthrs/fuzz"
import * as Anvil from "@smthrs/targets/Anvil"
import * as DocsCheck from "@smthrs/targets/DocsCheck"
import * as Factory from "@smthrs/targets/Factory"
import * as Home from "@smthrs/targets/Home"
import * as Input from "@smthrs/targets/Input"
import * as Package from "@smthrs/targets/Package"
import * as Secret from "@smthrs/targets/Secret"
import * as Target from "@smthrs/targets/Target"
import * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { Arbitrary, Effect, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as AnvilExec from "../src/AnvilExec.ts"
import * as CacheAdmin from "../src/CacheAdmin.ts"
import * as Diagnostic from "../src/Diagnostic.ts"
import * as FactoryLoader from "../src/FactoryLoader.ts"
import * as PathTools from "../src/internal/PathTools.ts"
import * as DocsCheckRule from "../src/internal/rules/DocsCheckRule.ts"
import * as ShellWords from "../src/internal/ShellWords.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 12)
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

describe("@smthrs/build-cli Wave-7A: AnvilExec, FactoryLoader, PathTools, ShellWords, Diagnostic, CacheAdmin & DocsCheckRule", () => {
  it(
    "AnvilExec.resolveAnvil & serviceSpec cover absent binary, real executable stub, latest & pinned forkBlockNumber",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          present: Schema.Boolean,
          pinned: Schema.Boolean,
          port: Schema.Int.check(Schema.isBetween({ minimum: 8545, maximum: 9545 }))
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ present, pinned, port }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w7a-anvil-", async (root) => {
                const binDir = NodePath.join(root, "bin")
                await Fs.mkdir(binDir, { recursive: true })
                if (present) {
                  const stub = NodePath.join(binDir, "anvil")
                  await Fs.writeFile(stub, "#!/bin/sh\necho 'anvil 0.2.0'\n", { mode: 0o755 })
                }
                const env = { PATH: present ? binDir : NodePath.join(root, "empty") }
                const attrs = Schema.decodeUnknownSync(Anvil.ForkAttrs)({
                  port,
                  forkUrl: Secret.Secret("RPC_URL"),
                  forkBlockNumber: pinned ? 123456 : "latest"
                })
                const spec = await AnvilExec.serviceSpec({
                  label: "//:fork",
                  cwd: root,
                  attrs,
                  environment: env
                })
                if (!present) {
                  expect("error" in spec).toBe(true)
                } else {
                  expect("argv" in spec).toBe(true)
                  if ("argv" in spec) {
                    expect(spec.argv).toContain("--port")
                    if (pinned) expect(spec.argv).toContain("--fork-block-number")
                  }
                }
              })
              return true
            }),
          { executions: Math.min(fsExecutions, 8), seed }
        )
      )
      assertPassed(report)
    },
    30_000
  )

  it("FactoryLoader.factoryFileBeside & validateFactoryModule cover every valid and invalid module namespace shape", async () => {
    const validFactory = Factory.Factory({ summary: "Demo." })
    const validHome = Home.Home({ blocks: [Home.Markdown({ path: "README.md" })] })
    const dummyTarget = Target.make("Wave7FactoryDummy", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Effect.void as never
    })({})
    const validPkg = Package.Package({ targets: { b: dummyTarget } })
    const validWs = WorkspaceDeclaration.Workspace("demo", {
      repository: "demo",
      cache: WorkspaceDeclaration.Cache({ directory: ".cache" })
    })

    expect(FactoryLoader.factoryFileBeside("WORKSPACE.ts")).toBe("FACTORY.ts")
    expect(FactoryLoader.factoryFileBeside(".smithers/WORKSPACE.ts")).toBe(".smithers/FACTORY.ts")
    const loaded = FactoryLoader.validateFactoryModule({ factory: validFactory, home: validHome }, "FACTORY.ts")
    expect(loaded.factory).toBe(validFactory)
    expect(loaded.home).toBe(validHome)

    const badNamespaces: ReadonlyArray<unknown> = [
      null,
      "not-object",
      {},
      { wrongName: validFactory },
      { factory: validFactory, wrongHome: validHome },
      { factory: "not-a-factory" },
      { factory: validFactory, home: "not-a-home" },
      { factory: validFactory, naked: dummyTarget },
      { factory: validFactory, pkg: validPkg },
      { factory: validFactory, ws: validWs }
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: badNamespaces.length - 1 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            expect(() => FactoryLoader.validateFactoryModule(badNamespaces[idx], "FACTORY.ts")).toThrow()
            return true
          }),
        { executions: Math.max(executions, 40), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it(
    "PathTools.directory & undeclared cover creation, idempotence, tool-directory clash & undeclared PATH shims",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          toolCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
          clash: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ toolCount, clash }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-w7a-pt-", async (root) => {
                const fakeHost = NodePath.join(root, "host-bin")
                await Fs.mkdir(fakeHost, { recursive: true })
                await Fs.writeFile(NodePath.join(fakeHost, "alpha"), "#!/bin/sh\n", { mode: 0o755 })
                await Fs.writeFile(NodePath.join(fakeHost, "beta"), "#!/bin/sh\n", { mode: 0o755 })
                await Fs.writeFile(NodePath.join(fakeHost, ".hidden"), "#!/bin/sh\n", { mode: 0o755 })

                const parent = NodePath.join(root, "tools")
                const tools = Array.from({ length: toolCount }, (_, i) => ({
                  name: `tool${i}`,
                  path: NodePath.join(fakeHost, "alpha")
                }))
                const dir1 = await PathTools.directory(parent, "k1", tools)
                const dir2 = await PathTools.directory(parent, "k1", tools)
                expect(dir2).toBe(dir1)

                if (clash) {
                  await expect(
                    PathTools.directory(parent, "k1", [{ name: "other", path: NodePath.join(fakeHost, "beta") }])
                  ).rejects.toThrow(/holds other tools/)
                }

                const und1 = await PathTools.undeclared(parent, `${fakeHost}:relative/ignored:/nonexistent-dir`, [
                  "alpha"
                ])
                const und2 = await PathTools.undeclared(parent, `${fakeHost}:relative/ignored:/nonexistent-dir`, [
                  "alpha"
                ])
                expect(und2).toBe(und1)
                const shimText = await Fs.readFile(NodePath.join(und1, "beta"), "utf8")
                expect(shimText).toContain(PathTools.undeclaredLine("beta"))
              })
              return true
            }),
          { executions: Math.min(fsExecutions, 10), seed: seed + 2 }
        )
      )
      assertPassed(report)
    },
    30_000
  )

  it("ShellWords.commands & Diagnostic rendering cover quotes, escapes, comments, ${...}, $(), backticks, env flags & unexpected logs", async () => {
    const scripts = [
      "echo 'single' \"double \\\"escaped\\\" $VAR `sub`\" \\n # comment\n",
      "FOO=1 env -i BAR=2 command -p exec -a x bash -c 'git status && curl http://x'",
      "echo ${HOME}/bin && $(uname -s) | `id` ; if ! true; then nohup time sh -lc 'jq .'; fi",
      "echo \\",
      "echo \"unterminated",
      "echo 'unterminated",
      "echo ${unterminated"
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        sIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: scripts.length - 1 })),
        verbose: Schema.Boolean
      })
    )
    await withTempDir("smthrs-w7a-diag-", async (root) => {
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ sIdx, verbose }) =>
            Effect.sync(() => {
              const cmds = ShellWords.commands(scripts[sIdx]!)
              expect(Array.isArray(cmds)).toBe(true)

              const sysErr = Object.assign(new Error("enoent"), { syscall: "open" })
              const taggedErr = Object.assign(new Error("tagged msg"), { _tag: "MyTag" })
              const typeErr = new TypeError("bug\u0007control")
              const proxyErr = new Proxy({}, {
                getOwnPropertyDescriptor() {
                  throw new Error("boom")
                }
              })

              expect(Diagnostic.present(taggedErr, { verbose })).toContain("tagged msg")
              expect(Diagnostic.present(sysErr, { verbose })).toContain(Diagnostic.unknownFailure)
              expect(Diagnostic.present(typeErr, { verbose })).toContain(Diagnostic.unknownFailure)
              expect(Diagnostic.present(null, { verbose })).toContain(Diagnostic.unknownFailure)
              expect(Diagnostic.error(proxyErr, "fallback").message).toBe("fallback")
              expect(Diagnostic.error("raw-str").message).toBe("raw-str")
              expect(Diagnostic.describe(proxyErr, "fb")).toBe("fb")
              expect(Diagnostic.unexpected(typeErr, root)).toContain("Diagnostics:")
              expect(Diagnostic.unexpected(null, NodePath.join(root, "no-such-parent", "sub"))).toContain("unavailable")
              expect(Diagnostic.report(taggedErr, { verbose })).toContain("tagged msg")
              expect(Diagnostic.report(typeErr, { verbose })).toContain("Diagnostics:")
              return true
            }),
          { executions: Math.max(executions, 30), seed: seed + 3 }
        )
      )
      assertPassed(report)
    })
  })

  it(
    "CacheAdmin.parseSize, directory, entries, inspect & remove + DocsCheckRule.contract cover cache pruning and docs stamp plans",
    async () => {
      expect(CacheAdmin.parseSize("100B")).toBe(100)
      expect(CacheAdmin.parseSize("2KB")).toBe(2000)
      expect(CacheAdmin.parseSize("2KiB")).toBe(2048)
      expect(CacheAdmin.parseSize("3MB")).toBe(3_000_000)
      expect(CacheAdmin.parseSize("1GB")).toBe(1_000_000_000)
      expect(() => CacheAdmin.parseSize("nope")).toThrow()

      await withTempDir("smthrs-w7a-ca-", async (root) => {
        const shardDir = NodePath.join(root, ".cache", "cache", "ab")
        await Fs.mkdir(shardDir, { recursive: true })
        await Fs.writeFile(
          NodePath.join(shardDir, "abentry1.json"),
          JSON.stringify({
            key: "abentry1",
            label: "//:a",
            target: "Shell.Build",
            exitOk: true,
            storedAt: new Date().toISOString(),
            pad: "a".repeat(200)
          })
        )
        await Fs.writeFile(
          NodePath.join(shardDir, "abentry2.json"),
          JSON.stringify({
            key: "abentry2",
            label: "//:b",
            target: "Shell.Build",
            exitOk: true,
            storedAt: new Date().toISOString(),
            pad: "b".repeat(200)
          })
        )

        const dir = await CacheAdmin.directory(root, ".cache")
        expect(dir).toBeDefined()
        const list = await CacheAdmin.entries(root, ".cache")
        expect(list.length).toBe(2)
        const info = await CacheAdmin.inspect(root, ".cache", "abentry1")
        expect(info?.exitOk).toBe(true)

        await expect(
          CacheAdmin.remove({ root, cacheDirectory: ".cache", maxSizeBytes: 100, dryRun: false, yes: false })
        ).rejects.toThrow(/--yes/)
        const dry = await CacheAdmin.remove({
          root,
          cacheDirectory: ".cache",
          maxSizeBytes: 100,
          dryRun: true,
          yes: false
        })
        expect(dry.candidates).toBeGreaterThan(0)
        const real = await CacheAdmin.remove({
          root,
          cacheDirectory: ".cache",
          maxSizeBytes: 100,
          dryRun: false,
          yes: true
        })
        expect(real.removed).toBeGreaterThan(0)

        const baseCheck: DocsCheck.Attrs = {
          output: Input.file("docs/guide.md"),
          stamp: Input.file("docs/guide.stamp.json"),
          producer: "//:gen",
          inputs: [Input.file("src/a.ts")]
        }
        const planIncludesOutput = DocsCheckRule.contract.plan({
          attrs: baseCheck,
          packagePath: "",
          docsFiles: () => [{ path: "docs/guide.md", digest: "abc" }]
        } as never)
        expect(planIncludesOutput.ok).toBe(false)

        const planIncludesStamp = DocsCheckRule.contract.plan({
          attrs: baseCheck,
          packagePath: "",
          docsFiles: () => [{ path: "docs/guide.stamp.json", digest: "abc" }]
        } as never)
        expect(planIncludesStamp.ok).toBe(false)

        const planDupEvidence = DocsCheckRule.contract.plan({
          attrs: {
            ...baseCheck,
            evidence: [
              { file: Input.file("ev.json"), maxAgeMs: 60_000 },
              { file: Input.file("ev.json"), maxAgeMs: 60_000 }
            ]
          },
          packagePath: "",
          docsFiles: () => [{ path: "src/a.ts", digest: "abc" }]
        } as never)
        expect(planDupEvidence.ok).toBe(false)

        const planErr = DocsCheckRule.contract.plan({
          attrs: baseCheck,
          packagePath: "",
          docsFiles: () => "refused"
        } as never)
        expect(planErr.ok).toBe(false)

        const planOk = DocsCheckRule.contract.plan({
          attrs: baseCheck,
          packagePath: "",
          docsFiles: () => [{ path: "src/a.ts", digest: "abc" }]
        } as never)
        expect(planOk.ok).toBe(true)

        const decl = DocsCheck.Check(baseCheck)
        if (planOk.ok) {
          const node = {
            declaration: decl,
            packagePath: "",
            mode: "write",
            lane: planOk.value.lane
          } as never
          await expect(DocsCheckRule.contract.execute(node, { root } as never)).rejects.toThrow(/missing/)
          await Fs.mkdir(NodePath.join(root, "docs"), { recursive: true })
          await Fs.writeFile(NodePath.join(root, "docs", "guide.md"), "# Guide\nHello\n")
          await DocsCheckRule.contract.execute(node, { root } as never)
        }
      })
    },
    30_000
  )
})
