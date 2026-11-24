import { Fuzz } from "@smthrs/fuzz"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Arbitrary, Effect, Exit, Latch, Layer, Schema } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as Cargo from "../src/Cargo.ts"
import * as DocsCheck from "../src/DocsCheck.ts"
import * as DocsParity from "../src/DocsParity.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as Input from "../src/Input.ts"
import * as NewPackage from "../src/NewPackage.ts"
import * as Owners from "../src/Owners.ts"
import * as Target from "../src/Target.ts"
import * as PackageJson from "../src/PackageJson.ts"

const executions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "120"))
const fsExecutions = Math.min(executions, 14)
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


const runExpandLive = (workspaceRoot: string, payload: Filegroup.Payload) => {
  type Reg = (p: Filegroup.Payload, id: string) => Effect.Effect<Filegroup.Files, Filegroup.FilegroupError>
  let registered: Reg | undefined
  const runtime = FlowRuntime.FlowRuntime.of({
    register: (_flow: unknown, execute: Reg) => Effect.sync(() => { registered = execute }),
    actionExecute: (action: { readonly execute: Effect.Effect<unknown, unknown> }) =>
      Effect.map(Effect.exit(action.execute), (exit) => new Flow.Complete({ exit }))
  } as unknown as FlowRuntime.FlowRuntime["Service"])
  return Effect.scoped(Effect.gen(function*() {
    yield* Layer.build(
      Filegroup.ExpandFilegroupLive({ workspaceRoot }).pipe(
        Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, runtime))
      )
    )
    const instance = FlowRuntime.FlowInstance.of({
      executionId: "fg-wave7",
      actionState: { count: 0, latch: Latch.makeUnsafe() }
    } as never)
    return yield* registered!(payload, "fg-wave7").pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provideService(FlowRuntime.FlowRuntime, runtime)
    )
  }))
}

describe("@smthrs/targets Wave-7E: DocsCheck, Cargo, Owners, Filegroup, NewPackage, DocsParity & PackageJson.sync", () => {
  it("DocsCheck.normalize covers frontmatter key stripping, section stripping & every YAML/Markdown refusal", async () => {
    const validDoc = [
      "---",
      "title: \"Hello\"",
      "updated: 2026-11-24",
      "tags: [a, b]",
      "---",
      "# Main",
      "Keep this.",
      "```ts",
      "## Ignored inside fence",
      "```",
      "## Changelog",
      "Drop this.",
      "## KeepAgain",
      "Back!"
    ].join("\n")

    const normalized = DocsCheck.normalize(validDoc, { frontmatterKeys: ["updated"], sections: ["Changelog"] })
    expect(normalized).toContain("updated: null")
    expect(normalized).not.toContain("Drop this.")
    expect(normalized).toContain("Back!")

    const badDocs: ReadonlyArray<{ readonly text: string; readonly ignore: DocsCheck.Ignore }> = [
      { text: "---\ntitle: unclosed", ignore: { frontmatterKeys: ["title"] } },
      { text: "---\ntitle: \"unclosed quote\n---\nbody", ignore: { frontmatterKeys: ["title"] } },
      { text: "---\ntitle: &anchor val\n---\nbody", ignore: { frontmatterKeys: ["title"] } },
      { text: "---\n  indented_without_key\n---\nbody", ignore: { frontmatterKeys: ["title"] } },
      { text: "---\nupdated: |\n  multi\n---\nbody", ignore: { frontmatterKeys: ["updated"] } },
      { text: "---\nupdated:\n  nested: 1\n---\nbody", ignore: { frontmatterKeys: ["updated"] } },
      { text: "  ```ts\n  code\n  ```\n", ignore: { sections: ["A"] } },
      { text: "```ts`bad\ncode\n```\n", ignore: { sections: ["A"] } },
      { text: "<div>html</div>\n", ignore: { sections: ["A"] } },
      { text: "<!-- comment -->\n", ignore: { sections: ["A"] } },
      { text: "## A\nSetext\n===\n", ignore: { sections: ["A"] } },
      { text: "```ts\nunclosed fence\n", ignore: { sections: ["A"] } }
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        idx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: badDocs.length - 1 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idx }) =>
          Effect.sync(() => {
            const c = badDocs[idx]!
            expect(() => DocsCheck.normalize(c.text, c.ignore)).toThrow()
            return true
          }),
        { executions: Math.max(executions, 40), seed }
      )
    )
    assertPassed(report)
  })

  it("Cargo.packageArgs, manifestFacts & Owners.declare cover all CLI arg variants, TOML metadata errors & Owners validation", async () => {
    const selections: ReadonlyArray<Cargo.CrateSelection> = [
      { _tag: "Workspace" },
      { _tag: "Package", name: "demo" },
      { _tag: "Manifest", path: "crates/demo/Cargo.toml" }
    ]
    const profiles = ["dev", "release", "bench-custom"] as const

    // Valid manifestFacts with nested metadata & arrays
    const facts = Cargo.manifestFacts(`[package]\nname = "demo"\n[package.metadata.smithers]\ntags = ["a", "b"]\n[package.metadata.smithers.nested]\nok = true\n`)
    expect(facts.name).toBe("demo")
    expect(facts.metadata).toBeDefined()

    // Reserved metadata key & deep nesting
    expect(() => Cargo.manifestFacts(`[package]\nname = "x"\n[package.metadata]\n__proto__ = 1\n`)).toThrow()
    let deepToml = `[package]\nname = "d"\n`
    deepToml += `[package.metadata.${Array.from({ length: 40 }, (_, i) => `k${i}`).join(".")}]\nv = 1\n`
    expect(() => Cargo.manifestFacts(deepToml)).toThrow()

    // Owners happy paths
    const o1 = Owners.declare({ owners: ["alice"], upstream: "none" })
    const o2 = Owners.declare({ owners: ["team:core"], upstream: "review", agents: "human-approve" })
    const o3 = Owners.declare({ owners: ["alice"], upstream: { mode: "approve", packages: ["//pkg/..."] } })
    expect(Owners.teamReferences(o2)).toEqual(["core"])
    expect(o1._tag).toBe("Owners")
    expect(o3.upstream?.mode).toBe("approve")

    const ownersBad: ReadonlyArray<() => unknown> = [
      () => Owners.declare({ owners: ["alice"], upstream: 123 as never }),
      () => Owners.declare({ owners: ["alice"], upstream: { mode: "review", extra: 1 } as never }),
      () => Owners.declare({ owners: ["alice"], upstream: { mode: "bad" } as never }),
      () => Owners.declare({ owners: ["alice"], upstream: { mode: "review", packages: [] } }),
      () => Owners.declare({ owners: ["alice"], upstream: { mode: "review", packages: ["not-a-label"] } }),
      () => Owners.declare({ owners: ["alice"], agents: { default: "bad" } as never }),
      () => Owners.declare({ owners: ["alice"], agents: { default: "deny", extra: [] } as never })
    ]

    const arb = Arbitrary.schema(
      Schema.Struct({
        selIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: selections.length - 1 })),
        profIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: profiles.length - 1 })),
        allFeat: Schema.Boolean,
        badIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: ownersBad.length - 1 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ selIdx, profIdx, allFeat, badIdx }) =>
          Effect.sync(() => {
            const args = Cargo.packageArgs("Cargo.Build", {
              allFeatures: allFeat,
              features: allFeat ? undefined : ["f1", "f2"],
              profile: profiles[profIdx]!,
              target: "x86_64-unknown-linux-gnu",
              locked: true,
              offline: true,
              lib: true,
              allTargets: true,
              bins: ["cli"]
            }, selections[selIdx]!)
            expect(args).toContain("build")
            expect(args).toContain("--bin")
            expect(() => ownersBad[badIdx]!()).toThrow()
            return true
          }),
        { executions: Math.max(executions, 40), seed: seed + 1 }
      )
    )
    assertPassed(report)
  })

  it("Filegroup nested sources + ExpandFilegroupLive, NewPackage.scaffold templates, DocsParity.checkDocs & PackageJson.sync cover real FS & error paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseKind: Schema.Literals([
          "filegroup-ok",
          "filegroup-escape",
          "scaffold-template-ok",
          "scaffold-template-missing",
          "scaffold-template-symlink",
          "scaffold-exists",
          "docsparity-missing",
          "docsparity-no-title",
          "docsparity-short",
          "docsparity-examples",
          "pkgjson-sync-write-check",
          "pkgjson-sync-bad-path",
          "pkgjson-sync-dup-gen"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ caseKind }) =>
          Effect.promise(async () => {
            await withTempDir("smthrs-t7e-", async (root) => {
              if (caseKind === "filegroup-ok") {
                await Fs.mkdir(NodePath.join(root, "pkg", "sub"), { recursive: true })
                await Fs.writeFile(NodePath.join(root, "pkg", "sub", "a.ts"), "export const a = 1\n")
                const inner = Filegroup.Filegroup({
                  cwd: "pkg",
                  srcs: [Input.glob("sub/**/*.ts", { exclude: ["sub/**/*.bak"] })]
                })
                const outer = Filegroup.Filegroup({
                  srcs: [inner, inner, Input.file("pkg/sub/a.ts")]
                })
                const srcs = Filegroup.sources(Target.metadata(outer).attrs as Filegroup.Attrs, { packageDirectory: "", sourceFile: "PACKAGE.ts" })
                expect(srcs.length).toBeGreaterThan(0)
                const expanded = await Effect.runPromise(runExpandLive(root, { sources: srcs }))
                expect(expanded.length).toBeGreaterThan(0)
              } else if (caseKind === "filegroup-escape") {
                const exit = await Effect.runPromise(
                  Effect.exit(runExpandLive(root, { sources: [{ base: "/outside/somewhere", source: Input.file("a.ts") }] }))
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (caseKind === "scaffold-template-ok") {
                await Fs.mkdir(NodePath.join(root, "templates", "basic", "src"), { recursive: true })
                await Fs.writeFile(NodePath.join(root, "templates", "basic", "src", "index.ts"), "export const name = \"{{name}}\"\n")
                const res = await Effect.runPromise(
                  NewPackage.scaffold(
                    { workspaceRoot: root, packageName: "@smthrs/demo" },
                    { directory: "packages", template: "templates/basic", version: "0.1.0", license: "MIT", fields: {} }
                  )
                )
                expect(res.directory).toContain("packages/demo")
              } else if (caseKind === "scaffold-template-missing") {
                const exit = await Effect.runPromise(
                  Effect.exit(
                    NewPackage.scaffold(
                      { workspaceRoot: root, packageName: "@smthrs/demo" },
                      { directory: "packages", template: "templates/nope", version: "0.1.0", license: "MIT", fields: {} }
                    )
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (caseKind === "scaffold-template-symlink") {
                await Fs.mkdir(NodePath.join(root, "templates", "bad"), { recursive: true })
                await Fs.writeFile(NodePath.join(root, "real.txt"), "hi")
                await Fs.symlink(NodePath.join(root, "real.txt"), NodePath.join(root, "templates", "bad", "sym.txt"))
                const exit = await Effect.runPromise(
                  Effect.exit(
                    NewPackage.scaffold(
                      { workspaceRoot: root, packageName: "@smthrs/demo" },
                      { directory: "packages", template: "templates/bad", version: "0.1.0", license: "MIT", fields: {} }
                    )
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (caseKind === "scaffold-exists") {
                await Fs.mkdir(NodePath.join(root, "packages", "demo"), { recursive: true })
                const exit = await Effect.runPromise(
                  Effect.exit(
                    NewPackage.scaffold(
                      { workspaceRoot: root, packageName: "@smthrs/demo" },
                      { directory: "packages", version: "0.1.0", license: "MIT", fields: {} }
                    )
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (caseKind === "docsparity-missing") {
                const exit = await Effect.runPromise(
                  Effect.exit(DocsParity.checkDocs({ workspaceRoot: root }, { path: "README.md", minimumProseCharacters: 10, examples: [] }))
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (caseKind === "docsparity-no-title") {
                await Fs.writeFile(NodePath.join(root, "README.md"), "no heading here at all\n")
                const exit = await Effect.runPromise(
                  Effect.exit(DocsParity.checkDocs({ workspaceRoot: root }, { path: "README.md", minimumProseCharacters: 5, examples: [] }))
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (caseKind === "docsparity-short") {
                await Fs.writeFile(NodePath.join(root, "README.md"), "# Title\nshort\n")
                const exit = await Effect.runPromise(
                  Effect.exit(DocsParity.checkDocs({ workspaceRoot: root }, { path: "README.md", minimumProseCharacters: 500, examples: [] }))
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (caseKind === "docsparity-examples") {
                await Fs.writeFile(NodePath.join(root, "README.md"), "# Title\n\nThis package provides durable utilities for testing documentation parity cleanly.\n")
                await Fs.writeFile(NodePath.join(root, "page.md"), "# Page\n```ts\nconst x = 1\n```\n")
                await Fs.writeFile(NodePath.join(root, "ex.ts"), "const x = 2\n")
                await Fs.writeFile(NodePath.join(root, "ex.test.ts"), "import ./ex.ts\n")
                const exit = await Effect.runPromise(
                  Effect.exit(
                    DocsParity.checkDocs({ workspaceRoot: root }, {
                      path: "README.md",
                      minimumProseCharacters: 20,
                      examples: [{ page: "page.md", example: "ex.ts", test: "ex.test.ts" }]
                    })
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else if (caseKind === "pkgjson-sync-write-check") {
                const payload: PackageJson.SyncPayload = {
                  mode: "write",
                  path: "package.json",
                  fields: { name: "@smthrs/demo", version: "1.0.0", description: "Demo pkg" },
                  generated: [],
                  readme: null,
                  sources: null,
                  promptVersion: "v1",
                  engine: "codex",
                  model: "openai/gpt-5-mini"
                }
                await Effect.runPromise(PackageJson.sync({ workspaceRoot: root, cacheDirectory: NodePath.join(root, ".cache") }, payload))
                await Effect.runPromise(PackageJson.sync({ workspaceRoot: root, cacheDirectory: NodePath.join(root, ".cache") }, { ...payload, mode: "check" }))
                // Drift check
                const driftExit = await Effect.runPromise(
                  Effect.exit(PackageJson.sync({ workspaceRoot: root, cacheDirectory: NodePath.join(root, ".cache") }, { ...payload, mode: "check", fields: { ...payload.fields, version: "2.0.0" } }))
                )
                expect(Exit.isFailure(driftExit)).toBe(true)
              } else if (caseKind === "pkgjson-sync-bad-path") {
                const exit = await Effect.runPromise(
                  Effect.exit(
                    PackageJson.sync({ workspaceRoot: root, cacheDirectory: NodePath.join(root, ".cache") }, {
                      mode: "check",
                      path: "/etc/passwd",
                      fields: { name: "x" },
                      generated: [],
                      readme: null,
                      sources: null,
                      promptVersion: "v1",
                      engine: "codex",
                      model: "openai/gpt-5-mini"
                    })
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
              } else {
                const exit = await Effect.runPromise(
                  Effect.exit(
                    PackageJson.sync({ workspaceRoot: root, cacheDirectory: NodePath.join(root, ".cache") }, {
                      mode: "write",
                      path: "package.json",
                      fields: { name: "x" },
                      generated: ["description", "description"],
                      readme: null,
                      sources: null,
                      promptVersion: "v1",
                      engine: "codex",
                      model: "openai/gpt-5-mini"
                    })
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
              }
            })
            return true
          }),
        { executions: Math.max(fsExecutions, 20), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 30_000)
})
