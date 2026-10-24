import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Agent from "../src/AgentTarget.ts"
import * as CiToolchain from "../src/CiToolchain.ts"
import * as Compose from "../src/Compose.ts"
import * as Config from "../src/Config.ts"
import * as DocsCheck from "../src/DocsCheck.ts"
import * as DocsParity from "../src/DocsParity.ts"
import * as FlowCatalog from "../src/FlowCatalog.ts"
import * as GeneratedFile from "../src/GeneratedFile.ts"
import * as CiGen from "../src/GithubCiGen.ts"
import * as Go from "../src/Go.ts"
import * as Home from "../src/Home.ts"
import * as Nix from "../src/Nix.ts"
import * as Owners from "../src/Owners.ts"
import * as Package from "../src/Package.ts"
import * as Defaults from "../src/PackageDefaults.ts"
import * as PackageJson from "../src/PackageJson.ts"
import * as Template from "../src/PackageJsonTemplate.ts"
import * as Pnpm from "../src/PnpmWorkspaceFile.ts"
import * as Reference from "../src/Reference.ts"
import * as Runtime from "../src/Runtime.ts"
import * as Rust from "../src/RustToolchain.ts"
import * as Secret from "../src/Secret.ts"
import * as Proxy from "../src/SecretProxy.ts"
import * as Shell from "../src/Shell.ts"
import * as S from "../src/Smithers.ts"
import * as Target from "../src/Target.ts"
import * as Tsconfig from "../src/Tsconfig.ts"
import * as Workspace from "../src/WorkspaceDeclaration.ts"
import { plannedArgv } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

let root: string
beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(join(tmpdir(), "honest-target-boundaries-")))
})
afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("manifest declaration boundaries", () => {
  const base = { name: "@example/widget", version: "1.0.0" }
  it.each([
    [new Date(), /plain object/],
    [Object.assign(Object.create({}), base), /plain object/],
    [{ ...base, [Symbol("hidden")]: 1 }, /symbol/],
    [Object.defineProperty({ ...base }, "engine", { value: "claude", enumerable: false }), /non-enumerable/],
    [{ ...base, scripts: new Date() }, /plain object/],
    [{ ...base, scripts: { [Symbol("hidden")]: S.Shell.Test({ shell: "true" }) } }, /symbol/],
    [{
      ...base,
      scripts: Object.defineProperty({}, "test", {
        get: () => {
          throw new Error("getter ran")
        },
        enumerable: true
      })
    }, /accessor/],
    [{ ...base, scripts: { " bad ": S.Shell.Test({ shell: "true" }) } }, /name is invalid/],
    [{ ...base, scripts: { test: {} } }, /must name a target/],
    [{ ...base, publish: [] }, /plain object/],
    [{ ...base, publish: new Date() }, /plain object/],
    [{ ...base, publish: { extra: true } }, /unknown option/],
    [{
      ...base,
      publish: Object.defineProperty({}, "entry", {
        get: () => {
          throw new Error("getter ran")
        },
        enumerable: true
      })
    }, /accessor/],
    [{ ...base, publish: { access: "private" } }, /access/],
    [{ ...base, publish: { provenance: "yes" } }, /boolean/],
    [{ ...base, license: "made-up-license" }, /license/],
    [{ ...base, fields: { name: "duplicate" } }, /modeled field/],
    [{ ...base, template: {} }, /template/],
    [{ ...base, output: 42 }, /output must be a string/],
    [{ ...base, readme: {} }, /Input.File/],
    [{ ...base, sources: {} }, /Input.Glob/]
  ])("refuses invalid author input without invoking it", (options, error) => {
    expect(() => PackageJson.PackageJson(options as never)).toThrow(error as RegExp)
  })

  it.each(["check", "write"] as const)(
    "reports invalid paths and non-object existing manifests in %s mode",
    async (mode) => {
      const payload = {
        path: "../package.json",
        mode,
        fields: base,
        generated: [],
        readme: null,
        sources: null,
        promptVersion: "1",
        engine: "claude",
        model: "sonnet"
      } as unknown as PackageJson.SyncPayload
      const invalidPath = await Effect.runPromise(
        Effect.flip(PackageJson.sync({ workspaceRoot: root, cacheDirectory: ".cache" }, payload))
      )
      expect(invalidPath).toMatchObject({ path: "../package.json" })
      expect(invalidPath.message).toMatch(/path|workspace/)
      await Fs.writeFile(join(root, "package.json"), "[]")
      const invalidManifest = await Effect.runPromise(
        Effect.flip(
          PackageJson.sync({ workspaceRoot: root, cacheDirectory: ".cache" }, { ...payload, path: "package.json" })
        )
      )
      expect(invalidManifest.message).toContain("checked-in manifest is invalid")
      if (mode === "check") expect(invalidManifest).toMatchObject({ reason: "unreadable" })
      expect(await Fs.readFile(join(root, "package.json"), "utf8")).toBe("[]")
    }
  )
})

describe("direct README checks", () => {
  it("rejects an untitled README and a title without enough prose", async () => {
    for (
      const [contents, message] of [["No heading here.", "no level-one title"], ["# Widget", "below the 10"]] as const
    ) {
      await Fs.writeFile(join(root, "README.md"), contents)
      const error = await Effect.runPromise(
        Effect.flip(DocsParity.checkDocs({ workspaceRoot: root }, { path: "README.md", minimumProseCharacters: 10 }))
      )
      expect(error.message).toContain(message)
      expect(error.path).toBe("README.md")
    }
  })
})

describe("toolchain and workspace declarations", () => {
  it.each([
    [null, /object/],
    [{ unknown: true }, /unknown option/],
    [{ mod: "go.mod", sum: S.file("go.sum") }, /S.file/],
    [{ mod: S.file("go.mod"), sum: S.file("go.sum"), versions: {} }, /toolchain declaration/]
  ])("refuses an unusable Go toolchain", (options, message) => {
    expect(() => Go.Toolchain(options as never)).toThrow(message as RegExp)
  })
  it("renders bounded YAML keys and settings deterministically", () => {
    expect(Pnpm.render(Pnpm.Attrs.make({
      packages: ["packages/*"],
      allowBuilds: { no: false, "1": true, "@scope/pkg": false, z: true },
      settings: { "no": false, "value": "x" }
    }))).toContain("\"no\": false")
    expect(Pnpm.render(Pnpm.Attrs.make({ packages: ["packages/*"], settings: { value: "x" } }))).toContain(
      "value: \"x\""
    )
    expect(Shell.flagToken("verbose")).toBe("{smthrs:flag:verbose}")
    expect(CiToolchain.Bun({ release: "1.4.1" } as never).name).toBe("bun")
  })
})

it("checks absent generated parents without creating them", async () => {
  const error = await Effect.runPromise(
    Effect.flip(GeneratedFile.checkGeneratedFile(root, { path: "missing/deep/file", contents: "x" }))
  )
  expect(error).toMatchObject({ reason: "missing", path: "missing/deep/file" })
  expect(await Fs.readdir(root)).toEqual([])
})

it("admits real target tool handles and rejects forged or primitive tools", () => {
  const guard = Schema.is(Reference.TargetTool)
  expect(guard(S.Shell.Build({ shell: "true", outDirs: ["dist"] }))).toBe(true)
  for (const value of [null, 1, "tool", {}, { _tag: "fake" }]) expect(guard(value)).toBe(false)
})

it("names an invalid declared credential without disclosing its value", () => {
  const vault = Proxy.makeVault({ read: () => "invalid\nvalue" })
  expect(() => vault.resolve(Secret.Secret("EXAMPLE_TOKEN"))).toThrow(/EXAMPLE_TOKEN.*not bounded/)
})

it("synthesizes the named targets returned by a default package macro", () => {
  const declaration = Defaults.PackageDefaults({
    directories: S.glob("packages/*"),
    macro: ({ cwd }: { cwd: string }) => ({ test: S.Shell.Test({ shell: "echo " + cwd }) })
  })
  const targets = Defaults.synthesize(declaration, "packages/widget")
  expect(targets.map(([name]) => name)).toEqual(["test"])
  expect(Target.metadata(targets[0]![1]).attrs).toMatchObject({ shell: "echo packages/widget" })
})

it("runs Cargo through the declared executable rather than a host default", () => {
  expect(Rust.cargo(Rust.Pinned({ cargo: "/toolchain/cargo", rustup: "/toolchain/rustup" }), ["check", "--locked"]))
    .toEqual([
      "/toolchain/cargo",
      "check",
      "--locked"
    ])
})

it("rejects symbol-bearing home options and non-string Rust executable declarations", () => {
  expect(() => Home.Stack({ [Symbol("hidden")]: true } as never)).toThrow(/symbol/)
  expect(() => Rust.Pinned({ cargo: 42 as never })).toThrow(/must be a string/)
})

it("uses the workspace root for a file-based Nix environment", () => {
  expect(Nix.flakeDirectory(Nix.Environment({ file: S.file("environment.nix") }))).toBe("")
})

it("reports an absent README and ignores an entirely blank document", async () => {
  const error = await Effect.runPromise(Effect.flip(DocsParity.checkDocs(
    { workspaceRoot: root },
    { path: "README.md", minimumProseCharacters: 1 }
  )))
  expect(error.message).toBe("the package has no README.md")
  expect(DocsParity.summarize(" \n\t")).toEqual({ title: undefined, proseCharacters: 0 })
})

it.each([null, "", "\ud800", "x".repeat(16385)])("refuses malformed audience text without echoing it", (audience) => {
  expect(() => Secret.normalizeAudience(audience as never)).toThrow(/bounded well-formed text/)
})
it("rejects exotic destination lists and forged credential arrays", () => {
  const secret = Secret.Secret("EXAMPLE_TOKEN")
  const extra = Object.assign(["https://example.com"], { extra: true })
  expect(() => Secret.HttpSecret(secret, extra)).toThrow(/dense array/)
  const sparse = new Array<string>(1)
  expect(() => Secret.HttpSecret(secret, sparse)).toThrow(/dense array/)
  for (const audiences of [null, [], Array(1000).fill("https://example.com"), extra, sparse]) {
    expect(Secret.isHttpCredential({ _tag: "HttpCredential", secret, audiences })).toBe(false)
  }
})
it.each([
  new Date(),
  { [Symbol("hidden")]: true },
  Object.defineProperty({}, "value", { value: true, enumerable: false })
])(
  "refuses a package-default macro returning an opaque record",
  (result) => {
    const declaration = Defaults.PackageDefaults({ directories: S.glob("packages/*"), macro: () => result })
    expect(() => Defaults.expand(declaration, "packages/widget")).toThrow(/plain record/)
  }
)
it("validates optional Go toolchain controls and linker option objects", () => {
  const versions = S.Mise({ config: S.file(".mise.toml") })
  const options = { mod: S.file("go.mod"), sum: S.file("go.sum"), versions }
  expect(() => Go.Toolchain({ ...options, cgo: "yes" as never })).toThrow(/cgo/)
  expect(() => Go.Toolchain({ ...options, experiments: [""] })).toThrow(/experiments/)
  expect(() => Go.ldflags(null as never)).toThrow(/object/)
  expect(() => Go.ldflags({ unknown: true } as never)).toThrow(/unknown option/)
})

it("validates runtime executable and reference name types", () => {
  expect(() => Reference.hostBin(42 as never)).toThrow(/must be a string/)
  expect(() => Runtime.Node({ version: ">=26.4.0", executable: 42 as never })).toThrow(/must be a string/)
  expect(() => Rust.Toolchain(null as never)).toThrow(/must be an object/)
  expect(() => Config.normalizeCacheDirectory("é".repeat(9000))).toThrow(/UTF-8 bytes/)
  for (const value of [null, 1, [], new globalThis.Proxy({}, {})]) expect(Template.isTemplate(value)).toBe(false)
})
it("validates package-default exclusions without executing getters", () => {
  const original = Defaults.PackageDefaults({
    directories: S.glob("packages/*"),
    macro: () => ({ test: S.Shell.Test({ shell: "true" }) })
  })
  for (
    const exclude of [null, 1, {}, new globalThis.Proxy([], {}), [
      42
    ], new Array(1)]
  ) {
    expect(Defaults.isPackageDefaults({ ...original, directories: { ...original.directories, exclude } })).toBe(false)
  }
})
it("expands nested file groups with each declaration's own source anchor", () => {
  const nested = S.Filegroup({ srcs: [S.glob("src/**")], cwd: "." })
  const anchoredNested = Object.defineProperty({}, Target.TargetTypeId, {
    value: { ...Target.metadata(nested), sourceFile: "packages/nested/PACKAGE.ts" }
  }) as Target.AnyTarget
  const other = S.Shell.Build({ shell: "true", outDirs: ["dist"] })
  const outer = S.Filegroup({ srcs: [anchoredNested, anchoredNested, other, S.file("readme.md")], cwd: "docs" })
  const sources = Compose.closureEntrySources([outer, S.file("entry.ts")], {
    sourceFile: undefined,
    packageDirectory: undefined
  })
  expect(sources).toEqual([
    { base: "packages/nested", source: S.glob("src/**") },
    { base: "", source: S.file("docs/readme.md") },
    { base: "", source: S.file("entry.ts") }
  ])
  const closure = Compose.ImportClosure({ entries: other })
  expect(Compose.checkOperand(closure)).toMatch(/cannot provide entry files/)
})

it("reports the first added, removed, or unchanged documentation input", () => {
  const row = (path: string) => ({ path, digest: "a".repeat(64) })
  expect(DocsCheck.firstDifference([], [row("a")])).toEqual({ path: "a", change: "added" })
  expect(DocsCheck.firstDifference([row("a")], [row("b")])).toEqual({ path: "a", change: "removed" })
  expect(DocsCheck.firstDifference([row("a")], [row("a")])).toBeUndefined()
})
it.each(
  [
    [undefined, undefined],
    ["", { path: "PACKAGE.ts", line: undefined, column: undefined }],
    ["\ud800", { path: "PACKAGE.ts", line: 1, column: undefined }],
    ["x".repeat(Target.maximumRejectionDetailCodeUnits + 1), { path: "PACKAGE.ts", line: 2, column: 3 }],
    [42, undefined],
    [null, undefined],
    [new globalThis.Proxy({}, {}), undefined]
  ] as const
)("renders bounded declaration diagnostics without inspecting hostile causes", (message, site) => {
  const cause = typeof message === "string" ? new Error(message) : message
  const error = Target.declarationRejected("Example", site, cause)
  expect(error.message).toContain("Example declaration")
  expect(error.message).toContain("is invalid")
  expect(error.message.isWellFormed()).toBe(true)
  expect(error.message.length).toBeLessThan(Target.maximumRejectionDetailCodeUnits + 100)
  expect(error.cause).toBe(cause)
})

it("plans a Bun inline program and falls back for an invalid duration", () => {
  expect(Shell.durationMs("not-a-duration")).toBe(Shell.packageExecTimeoutMs)
  const target = S.Shell.Test({ bun: "console.log('ran')" })
  expect(plannedArgv(target)).toEqual([Shell.bunToken, Shell.bunProgramToken])
})
it("rejects non-record package declarations and generates keyword metadata explicitly", () => {
  for (const value of [null, 1, [], new globalThis.Proxy({}, {})]) {
    expect(() => PackageJson.PackageJson(value as never)).toThrow(/object/)
    expect(() => PackageJson.PackageJson({ ...value as object, scripts: 1 } as never)).toThrow()
  }
  const declaration = PackageJson.PackageJson({ name: "widget", version: "1.0.0", keywords: PackageJson.generated })
  expect(declaration).toBeDefined()
})

it("bounds guidance from a real validation result with many excess properties", () => {
  const schema = Schema.Struct({ known: Schema.String })
  let cause: unknown
  try {
    Schema.decodeUnknownSync(schema, { errors: "all", onExcessProperty: "error" })(
      Object.fromEntries([["known", "value"], ...Array.from({ length: 20 }, (_, i) => ["extra" + i, true])])
    )
  } catch (error) {
    cause = error
  }
  expect(cause).toBeDefined()
  const error = Target.declarationRejected("ManyErrors", undefined, cause)
  expect(error.message).toContain("ManyErrors declaration")
  expect(error.message.length).toBeLessThan(Target.maximumRejectionDetailCodeUnits + 100)
})
it("rejects an invalid presentation before a guarded Cargo declaration is planned", () => {
  expect(() => S.Cargo.Build({ summary: 42 } as never)).toThrow(/declaration.*invalid/)
})

it("accepts null-prototype declaration options and rejects opaque prototypes", () => {
  expect(Config.Workspace(Object.create(null))).toMatchObject({ cacheDirectory: ".flows" })
  expect(() => Config.Workspace(Object.create({}))).toThrow(/plain object/)
  expect(Home.plainOptions("example", Object.create(null), new Set())).toEqual({})
  expect(() => Home.plainOptions("example", Object.create({}), new Set())).toThrow(/plain object/)
  expect(Owners.declare(Object.create(null))).toBeDefined()
  expect(() => Owners.declare(Object.create({}))).toThrow(/plain object/)
  expect(() => Package.Package({ targets: Object.create({}) })).toThrow(/plain object/)
  expect(Package.Package({ targets: Object.create(null) })).toBeDefined()
})
it("retains optional metadata when constructing flow catalog rows", () => {
  const row = {
    id: "x",
    description: "example",
    kind: "ts" as const,
    path: "flows/x/flow.ts",
    capabilities: [],
    model: null,
    modelInvocable: true
  }
  expect(FlowCatalog.rows([row], [])[0]).not.toHaveProperty("flows")
  expect(FlowCatalog.rows([{ ...row, id: "a" }, { ...row, id: "z" }], []).map((row) => row.id)).toEqual(["a", "z"])
  expect(FlowCatalog.rows([{ ...row, flows: ["y"], budget: { tokens: 10 }, inputSchema: { type: "object" } }], [])[0])
    .toMatchObject({
      flows: ["y"],
      budget: { tokens: 10 },
      inputSchema: { type: "object" }
    })
})
it("renders optional tool installers and a blank shell step without inventing arguments", () => {
  const attrs = CiGen.Attrs.make({ jobs: [], packageManager })
  const toolchain = CiToolchain.Toolchain.make({
    runtimes: [CiToolchain.Bun({ release: "1.4.1" })],
    submodules: false,
    install: false,
    ripgrep: CiToolchain.Ripgrep({ release: "14.1.1" })
  })
  const steps = CiGen.toolchainSteps(attrs, CiGen.Job.make({ id: "tools", name: "Tools", steps: [], toolchain }))
  expect(steps).toContainEqual({ uses: CiGen.actions.setupBun, with: { "bun-version": "1.4.1" } })
  expect(steps.some((step) => step.name === "Install ripgrep")).toBe(true)
  expect(CiGen.renderStep({ run: "first\n\nlast" }, "")).toContain("")
  expect(CiToolchain.Rust({}).cache).toBe(true)
  expect(CiToolchain.Bun({ release: "1.4.1", runtime: Runtime.Bun({ version: ">=1.4.0" }) }).runtime).toBeDefined()
})

it("rejects a cache path whose normalized multibyte segments exceed the total byte bound", () => {
  expect(() => Config.normalizeCacheDirectory(Array(30).fill("é".repeat(100)).join("/"))).toThrow(
    /at most.*UTF-8 bytes/
  )
})
it("refuses a guarded Cargo declaration with missing attrs", () => {
  expect(() => S.Cargo.Build(undefined as never)).toThrow()
})
it("keys unencodable scalar attrs consistently and refuses cyclic gate identities", () => {
  const rule = Target.make("IdentityBoundary", {
    kinds: ["build"],
    attrs: Schema.Struct({ value: Schema.Unknown }),
    implementation: () => Node.succeed(undefined)
  })
  const hashes = [undefined, 1n, Symbol("value"), () => 1].map((value) => Agent.targetIdentity(rule({ value })))
  expect(new Set(hashes).size).toBe(1)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(() => Agent.targetIdentity(rule({ value: cyclic }))).toThrow(/cyclic attr value/)
})
it("refuses primitive package declaration handles and workspace markers", () => {
  for (const value of [null, undefined, 1, "workspace"]) {
    expect(PackageJson.isDeclaration(value)).toBe(false)
    expect(Workspace.isWorkspaceDeclaration(value)).toBe(false)
  }
})
it("defaults Biome's path arguments to the current directory without declared sources", () => {
  const argv = plannedArgv(
    S.BiomeCheck({ packageManager, deps: [], sources: [], config: S.file("biome.json"), lint: true, format: false })
  )
  expect(argv.at(-1)).toBe(".")
})

it.each([null, 42, [], new globalThis.Proxy({}, {})])("rejects a non-record manifest script map", (scripts) => {
  expect(() => PackageJson.PackageJson({ name: "widget", version: "1.0.0", scripts } as never)).toThrow(
    /scripts must be a plain object/
  )
})
it("preserves keyword-only generation and default script maps", () => {
  const value = PackageJson.PackageJson({ name: "widget", version: "1.0.0", keywords: PackageJson.generated })
  expect(value.generated).toEqual(["keywords"])
  expect(Object.keys(value.scripts)).toEqual([])
})

it("recognizes a workspace carrying a declared sandbox capability", () => {
  const sandboxes = S.Sandboxes({ default: S.Sandbox.None() })
  const workspace = Config.Workspace({ sandboxes })
  expect(Config.isWorkspace(workspace)).toBe(true)
  expect(Config.isWorkspace({ ...workspace, sandboxes: {} })).toBe(false)
})
it.each([Array(257).fill("keyword"), 42])(
  "rejects an oversized or non-array literal keyword declaration",
  (keywords) => {
    expect(() => PackageJson.PackageJson({ name: "widget", version: "1.0.0", keywords } as never)).toThrow(/keywords/)
  }
)

it("renders actual excess-key diagnostics for record, symbol-keyed, and tuple schemas", () => {
  const symbolic = Symbol("required")
  const probes = [
    [Schema.Record(Schema.String.check(Schema.isPattern(/^valid/)), Schema.String), { extra: "value" }],
    [Schema.Struct({ [symbolic]: Schema.String }), { [symbolic]: "value", extra: "value" }],
    [Schema.Tuple([Schema.String]), ["value", "extra"]]
  ] as const
  for (const [schema, value] of probes) {
    let issue: unknown
    try {
      Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)
    } catch (error) {
      issue = error
    }
    expect(issue).toBeDefined()
    const cause = issue as { issue?: unknown }
    const error = Target.declarationRejected("Excess", undefined, new Error("invalid", { cause: cause.issue }))
    expect(error.message).toContain("Excess declaration")
  }
})
it("limits guidance across a real aggregate schema failure", () => {
  const schema = Schema.Struct({ known: Schema.String })
  let caught: unknown
  try {
    Schema.decodeUnknownSync(schema, { errors: "all", onExcessProperty: "error" })(
      Object.fromEntries([["known", "value"], ...Array.from({ length: 20 }, (_, i) => ["extra" + i, true])])
    )
  } catch (error) {
    caught = error
  }
  const issue = (caught as { issue: unknown }).issue
  const error = Target.declarationRejected("Aggregate", undefined, new Error("invalid", { cause: issue }))
  expect(error.message).toContain("unknown property")
  expect(error.message.match(/unknown property/g)?.length).toBe(Target.maximumGuidanceLines)
})

it("rebases a tsconfig include that names its own containing directory to a dot", () => {
  const rendered = JSON.parse(
    Tsconfig.render(Tsconfig.Attrs.make({ cwd: "pkg", path: "config/tsconfig.json", include: ["config"] }))
  )
  expect(rendered.include).toEqual(["."])
})
