import { Fuzz } from "@smthrs/fuzz"
import { Evaluator } from "@smthrs/model"
import { Arbitrary, Effect, Exit, Layer, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as GeneratedFile from "../src/GeneratedFile.ts"
import * as Go from "../src/Go.ts"
import * as Home from "../src/Home.ts"
import * as Input from "../src/Input.ts"
import * as JevLint from "../src/JevLint.ts"
import * as JobKeeper from "../src/JobKeeper.ts"
import * as ManifestJson from "../src/ManifestJson.ts"
import * as Nix from "../src/Nix.ts"
import * as Package from "../src/Package.ts"
import * as PackageJsonTemplate from "../src/PackageJsonTemplate.ts"
import * as RemoteCache from "../src/RemoteCache.ts"
import * as Secret from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import * as TargetIndex from "../src/TargetIndex.ts"

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

describe("@smthrs/targets Wave-7D: RemoteCache, Nix, Home, PackageJsonTemplate, Package, TargetIndex, Go, ManifestJson, GeneratedFile, JevLint & JobKeeper", () => {
  it("RemoteCache, Nix, Home, PackageJsonTemplate, Package, TargetIndex, Go & ManifestJson cover validation and happy paths", async () => {
    const validPubTok = `smithers_cachero_${"a".repeat(40)}`
    expect(RemoteCache.normalizePublicReadToken(validPubTok)).toBe(validPubTok)
    const rc = RemoteCache.make({
      endpoint: "https://cache.example.com/",
      write: Secret.Secret("WRITE_TOK"),
      publicReadToken: validPubTok
    })
    expect(rc.endpoint).toBe("https://cache.example.com")

    // Nix DevShell & Environment
    const ds = Nix.DevShell({ flake: Input.file("flake.nix"), lock: Input.file("flake.lock") })
    expect(ds._tag).toBe("NixDevShell")
    const env1 = Nix.Environment({ flake: Input.file("flake.nix"), lock: Input.file("flake.lock"), attr: "dev" })
    expect(Nix.environmentInputs(env1).length).toBe(2)
    expect(Nix.flakeDirectory(env1)).toBe("")
    expect(Nix.outputAttribute(env1, "x86_64-linux")).toBe("devShells.x86_64-linux.dev")
    expect(Nix.developArguments(env1).length).toBeGreaterThan(0)

    // Home sections happy path
    const hSec = Home.Home({
      sections: [{
        title: "Core",
        audience: "everyone",
        blocks: [Home.Markdown({ path: "README.md", title: "Hello" })]
      }],
      docs: "https://docs.example.com"
    })
    expect(hSec._tag).toBe("HomeDeclaration")

    // PackageJsonTemplate happy path
    const tpl = PackageJsonTemplate.make({
      license: "MIT",
      engines: { node: ">=22.0.0" },
      author: "Smithers",
      sideEffects: false,
      type: "module"
    })
    expect(PackageJsonTemplate.isTemplate(tpl)).toBe(true)

    // Package with wrappable Input.file & Input.glob
    const dummyTarget = Target.make("Wave7PkgTarget", {
      attrs: Schema.Struct({}),
      kinds: ["build"],
      implementation: () => Effect.void as never
    })({})
    const pkg = Package.Package({
      targets: {
        build: dummyTarget,
        readme: Input.file("README.md"),
        srcs: Input.glob("src/**/*.ts")
      }
    })
    expect(Package.isPackage(pkg)).toBe(true)
    expect(Package.metadata(pkg).abi).toBe(Package.abi)

    // TargetIndex render & TargetIndex target
    const rendered = TargetIndex.render([
      {
        label: "//:build",
        package: "",
        name: "build",
        rule: "Shell.Build",
        kinds: ["build"],
        cacheable: true,
        inputs: [
          { kind: "file", path: "a.ts" },
          { kind: "glob", pattern: "**/*.ts", exclude: [] },
          { kind: "link", path: "l" },
          { kind: "git-diff", base: "main" }
        ],
        outputs: ["dist"],
        dependencies: [],
        source: { file: "PACKAGE.ts" }
      }
    ])
    expect(rendered).toContain("//:build")
    const ti = TargetIndex.TargetIndex({ mode: "write" })
    const tiMeta = Target.metadata(ti)
    expect((tiMeta.forKind("lint").attrs as TargetIndex.Attrs).mode).toBe("check")
    expect((tiMeta.forKind("build").attrs as TargetIndex.Attrs).mode).toBe("write")

    // Go rules & Toolchain
    const goTc = Go.Toolchain({
      mod: Input.file("go.mod"),
      sum: Input.file("go.sum"),
      versions: ds,
      cgo: false,
      experiments: ["arenas"]
    })
    expect(goTc._tag).toBe("GoToolchain")
    expect(Go.ldflags({ strip: true, stamp: { "main.version": "1.0.0" } })).toContain("main.version")
    const goPkgs = Go.Packages({ pkgs: ["./..."] })
    expect(Target.isTarget(goPkgs)).toBe(true)
    expect(Target.isTarget(Go.Test({ pkgs: goPkgs }))).toBe(true)
    expect(Target.isTarget(Go.Binary({ pkg: "./cmd/app", out: "bin/app" }))).toBe(true)
    expect(
      Target.isTarget(Go.ModDownload({ mod: Input.file("go.mod"), sum: Input.file("go.sum"), outDirs: ["vendor"] }))
    ).toBe(true)
    expect(Target.isTarget(Go.Lint({ config: Input.file(".golangci.yml"), version: "v2.0.0", pkgs: ["./..."] }))).toBe(
      true
    )
    expect(Target.isTarget(Go.Generate({ pkgs: goPkgs, changes: ["gen.go"] }))).toBe(true)
    expect(Target.isTarget(Go.Fuzz({ pkg: "./pkg", fuzz: "FuzzX", time: "5s" }))).toBe(true)

    const getterObj: Record<string, unknown> = {}
    Object.defineProperty(getterObj, "endpoint", { get: () => "https://a.example", enumerable: true })
    const symObj: Record<PropertyKey, unknown> = { [Symbol("s")]: 1, endpoint: "https://a.example" }
    const nonPlain = new Map()
    const proxyObj = new Proxy({}, {})

    const badCases: ReadonlyArray<() => unknown> = [
      // RemoteCache errors
      () => RemoteCache.normalizePublicReadToken(123 as never),
      () => RemoteCache.normalizePublicReadToken("not-a-pub-token"),
      () => RemoteCache.normalizeEndpoint(123 as never),
      () => RemoteCache.normalizeEndpoint("https://a.example/\u0007"),
      () => RemoteCache.normalizeEndpoint("https://a.example/" + "a".repeat(9000)),
      () => RemoteCache.normalizeEndpoint("not-a-url"),
      () => RemoteCache.normalizeEndpoint("https://user:pass@a.example"),
      () => RemoteCache.normalizeEndpoint("http://a.example"),
      () => RemoteCache.normalizeEndpoint("https://a.example?q=1"),
      () => RemoteCache.normalizeEndpoint("https://a.example#frag"),
      () => RemoteCache.normalizeTokenEnv(123 as never),
      () => RemoteCache.normalizeTokenEnv("BAD\u0000ENV"),
      () => RemoteCache.normalizeTokenEnv("9BAD!"),
      () => RemoteCache.normalizeTokenEnv("SMITHERS_CACHE_URL"),
      () => RemoteCache.make(nonPlain as never),
      () => RemoteCache.make(proxyObj as never),
      () => RemoteCache.make(symObj as never),
      () => RemoteCache.make({ endpoint: "https://a.example", extra: 1 } as never),
      () => RemoteCache.make(getterObj as never),
      () =>
        RemoteCache.make(
          { endpoint: "https://a.example", token: Secret.Secret("A"), read: Secret.Secret("B") } as never
        ),
      () =>
        RemoteCache.make(
          { endpoint: "https://a.example", read: Secret.Secret("A"), publicReadToken: validPubTok } as never
        ),
      // Nix errors
      () => Nix.DevShell(null as never),
      () => Nix.DevShell({ flake: Input.file("flake.nix"), lock: Input.file("flake.lock"), extra: 1 } as never),
      () => Nix.DevShell({ flake: "bad" as never, lock: Input.file("flake.lock") }),
      () => Nix.Environment(null as never),
      () => Nix.Environment({ flake: Input.file("flake.nix"), lock: Input.file("flake.lock"), attr: "9bad!" }),
      () =>
        Nix.Environment(
          { flake: Input.file("flake.nix"), lock: Input.file("flake.lock"), file: Input.file("shell.nix") } as never
        ),
      () => Nix.Environment({ flake: Input.file("bad space.nix"), lock: Input.file("flake.lock") }),
      // Home errors
      () => Home.plainOptions("T", nonPlain, new Set()),
      () => Home.plainOptions("T", proxyObj, new Set()),
      () => Home.plainOptions("T", symObj, new Set()),
      () => Home.plainOptions("T", getterObj, new Set(["endpoint"])),
      () => Home.Home({ blocks: [], sections: [] } as never),
      () => Home.Home({ blocks: [], docs: [] } as never),
      () => Home.Home({ blocks: "nope" as never }),
      () => Home.Home({ sections: "nope" as never }),
      () => Home.Home({ sections: Array.from({ length: 50 }, () => ({ blocks: [] })) }),
      () => Home.Home({ sections: [{ blocks: "nope" as never }] }),
      () =>
        Home.Home({ sections: [{ blocks: Array.from({ length: 100 }, () => Home.Markdown({ path: "README.md" })) }] }),
      // PackageJsonTemplate errors
      () => PackageJsonTemplate.make(null as never),
      () => PackageJsonTemplate.make({ unknownField: 1 } as never),
      () => PackageJsonTemplate.assertNotManagerOwned("pkg", { dependencies: {} }),
      () => PackageJsonTemplate.make({ scripts: { build: 123 as never } } as never),
      // Package errors
      () => Package.Package(null as never),
      () => Package.Package({ targets: null as never }),
      () => Package.Package({ targets: { "bad name!": dummyTarget } }),
      () => Package.Package({ targets: { ok: "not-a-target" as never } }),
      () => Package.metadata({} as never),
      // Go errors
      () => Go.Toolchain(null as never),
      () => Go.Toolchain({ mod: Input.file("go.mod"), sum: Input.file("go.sum"), versions: ds, extra: 1 } as never),
      () => Go.Toolchain({ mod: "bad" as never, sum: Input.file("go.sum"), versions: ds }),
      () => Go.Toolchain({ mod: Input.file("go.mod"), sum: Input.file("go.sum"), versions: {} as never }),
      () => Go.Toolchain({ mod: Input.file("go.mod"), sum: Input.file("go.sum"), versions: ds, cgo: "yes" as never }),
      () => Go.Toolchain({ mod: Input.file("go.mod"), sum: Input.file("go.sum"), versions: ds, experiments: [""] }),
      // ManifestJson errors
      () => ManifestJson.cloneValue(undefined),
      () => ManifestJson.cloneValue(Number.NaN),
      () => ManifestJson.cloneValue(() => {}),
      () => ManifestJson.cloneValue(Symbol("x")),
      () => ManifestJson.cloneValue(proxyObj),
      () => ManifestJson.cloneValue(new Date()),
      () => ManifestJson.cloneObject([]),
      () => ManifestJson.cloneObject(symObj),
      () => ManifestJson.cloneObject(getterObj),
      () => ManifestJson.cloneValue("\uD800")
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: badCases.length - 1 }))
      })
    )
    for (const fn of badCases) expect(() => fn()).toThrow()
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            expect(() => badCases[idx]!()).toThrow()
            return true
          }),
        { executions: Math.max(executions, badCases.length * 3), seed }
      )
    )
    assertPassed(report)
  })

  it(
    "GeneratedFile.failureMessage, resolveOutputPath, writeGeneratedFile & checkGeneratedFile cover validation and edge failures",
    async () => {
      expect(GeneratedFile.failureMessage(null)).toBe("unknown failure")
      expect(GeneratedFile.failureMessage(new Proxy({}, {}))).toBe("unknown failure")
      expect(GeneratedFile.failureMessage(42n)).toBe("42")
      expect(GeneratedFile.failureMessage(Symbol("s"))).toContain("Symbol")
      const throwMsg = {}
      Object.defineProperty(throwMsg, "message", {
        get: () => {
          throw new Error("nope")
        },
        enumerable: true
      })
      expect(GeneratedFile.failureMessage(throwMsg)).toBe("unknown failure")

      const arb = Arbitrary.schema(
        Schema.Struct({
          caseKind: Schema.Literals([
            "abs-path",
            "empty-path",
            "deep-path",
            "long-path",
            "unpaired-surrogate",
            "symlink-parent",
            "write-and-check-ok",
            "check-drift",
            "symlink-write-check"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ caseKind }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-t7d-gf-", async (root) => {
                if (caseKind === "abs-path") {
                  expect(() => GeneratedFile.resolveOutputPath("/etc/passwd")).toThrow()
                } else if (caseKind === "empty-path") {
                  expect(() => GeneratedFile.resolveOutputPath(".")).toThrow()
                } else if (caseKind === "deep-path") {
                  const deep = Array.from({ length: 260 }, (_, i) => `d${i}`).join("/") + "/f.txt"
                  const exit = await Effect.runPromise(
                    Effect.exit(GeneratedFile.writeGeneratedFile(root, { path: deep, contents: "x" }))
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                } else if (caseKind === "long-path") {
                  const longP = "a".repeat(17_000) + ".txt"
                  const exit = await Effect.runPromise(
                    Effect.exit(GeneratedFile.writeGeneratedFile(root, { path: longP, contents: "x" }))
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                } else if (caseKind === "unpaired-surrogate") {
                  const exit = await Effect.runPromise(
                    Effect.exit(GeneratedFile.writeGeneratedFile(root, { path: "bad.txt", contents: "\uD800" }))
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                } else if (caseKind === "symlink-parent") {
                  const realDir = NodePath.join(root, "real")
                  await Fs.mkdir(realDir)
                  await Fs.symlink(realDir, NodePath.join(root, "symdir"))
                  const exit = await Effect.runPromise(
                    Effect.exit(GeneratedFile.writeGeneratedFile(root, { path: "symdir/a.txt", contents: "x" }))
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                } else if (caseKind === "write-and-check-ok") {
                  await Effect.runPromise(
                    GeneratedFile.writeGeneratedFile(root, { path: "nested/out.txt", contents: "ok\n" })
                  )
                  await Effect.runPromise(
                    GeneratedFile.checkGeneratedFile(root, { path: "nested/out.txt", contents: "ok\n" })
                  )
                } else if (caseKind === "check-drift") {
                  await Effect.runPromise(
                    GeneratedFile.writeGeneratedFile(root, { path: "drift.txt", contents: "v1\n" })
                  )
                  const exit = await Effect.runPromise(
                    Effect.exit(GeneratedFile.checkGeneratedFile(root, { path: "drift.txt", contents: "v2\n" }))
                  )
                  expect(Exit.isFailure(exit)).toBe(true)
                } else {
                  await Effect.runPromise(
                    GeneratedFile.writeGeneratedFile(root, { path: "target.txt", contents: "hi" })
                  )
                  await Effect.runPromise(
                    GeneratedFile.writeGeneratedSymlink(root, { path: "link.txt", target: "target.txt" })
                  )
                  await Effect.runPromise(
                    GeneratedFile.checkGeneratedSymlink(root, { path: "link.txt", target: "target.txt" })
                  )
                  const badExit = await Effect.runPromise(
                    Effect.exit(GeneratedFile.checkGeneratedSymlink(root, { path: "link.txt", target: "other.txt" }))
                  )
                  expect(Exit.isFailure(badExit)).toBe(true)
                }
              })
              return true
            }),
          { executions: Math.max(fsExecutions, 18), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    30_000
  )

  it(
    "JevLint.review covers invalid payload, oversized file not-judged, judge error, unanswered rule & threshold findings",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals(["bad-payload", "oversized", "judge-fail", "missing-answer", "finding-error", "clean"])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode }) =>
            Effect.promise(async () => {
              await withTempDir("smthrs-t7d-jev-", async (root) => {
                const targetFile = NodePath.join(root, "sample.ts")
                await Fs.writeFile(
                  targetFile,
                  mode === "oversized" ? "x".repeat(JevLint.maximumJudgedFileBytes + 64) : "export const x = 1\n"
                )

                const payload: JevLint.Payload = {
                  rules: [
                    {
                      id: "no-bad",
                      files: [Input.glob("sample.ts")],
                      lookFor: "Does the file contain a bad pattern?",
                      violation: "contains bad pattern",
                      compliant: "no bad pattern",
                      severity: "error"
                    }
                  ],
                  threshold: 0.7,
                  failOn: "error",
                  model: "openai/gpt-5-mini"
                }

                const fakeEvaluator = {
                  evaluate: () => {
                    if (mode === "judge-fail") {
                      return Effect.fail({ _tag: "JevError", message: "provider down" } as never)
                    }
                    if (mode === "missing-answer") {
                      return Effect.succeed({ answers: {}, usage: { inputTokens: 10 } } as never)
                    }
                    if (mode === "finding-error") {
                      return Effect.succeed({
                        answers: { "no-bad": { type: "boolean", value: true, probability: 0.95 } },
                        usage: { inputTokens: 25 }
                      } as never)
                    }
                    return Effect.succeed({
                      answers: { "no-bad": { type: "boolean", value: false, probability: 0.1 } },
                      usage: { inputTokens: 15 }
                    } as never)
                  }
                }

                const exit = await Effect.runPromise(
                  Effect.exit(
                    JevLint.review(
                      {
                        workspaceRoot: root,
                        judge: Layer.succeed(Evaluator.Evaluator, fakeEvaluator as never),
                        concurrency: 2,
                        timeoutMs: 5_000
                      },
                      mode === "bad-payload" ? ({ rules: [] } as never) : payload
                    )
                  )
                )
                if (mode === "clean") {
                  expect(Exit.isSuccess(exit)).toBe(true)
                } else {
                  expect(Exit.isFailure(exit)).toBe(true)
                }
              })
              return true
            }),
          { executions: Math.max(fsExecutions, 12), seed: seed + 2 }
        )
      )
      assertPassed(report)
    },
    30_000
  )

  it("JobKeeper.childrenOf & allEnded cover Linux /proc and non-Linux signal paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        plat: Schema.Literals(["linux", "darwin"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ plat }) =>
          Effect.promise(async () => {
            expect(Array.isArray(JobKeeper.childrenOf(999_999_999))).toBe(true)
            // Nonexistent PID finishes immediately
            const deadDone = await JobKeeper.allEnded([999_999_999], 20, plat)
            expect(deadDone).toBe(true)
            // Current PID is alive, so short deadline returns false
            const selfDone = await JobKeeper.allEnded([process.pid], 15, plat)
            expect(selfDone).toBe(false)
            return true
          }),
        { executions: Math.min(executions, 8), seed: seed + 3 }
      )
    )
    assertPassed(report)
  }, 30_000)
})
