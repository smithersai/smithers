import * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { isPackageError, PackageError } from "../src/PackageError.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const forceSpec = NodePath.resolve(import.meta.dirname, "fixtures/force-spec")

const openIndex = async (root: string): Promise<PackageIndex> => {
  const discovery = await PackageDiscovery.discover(root)
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.make(loaded)
}

/** The complete golden label list, derived by hand from the fixture maps. */
const goldenLabels = [
  // root PACKAGE.ts
  "//:claudeConfig",
  "//:claudeMd",
  "//:commit",
  "//:deleteReviewApp",
  "//:detectSecrets",
  "//:detectSecretsRegen",
  "//:detectSecretsRescan",
  "//:hokusai",
  "//:localPaletteDev",
  "//:localPaletteDevStop",
  "//:postCommit",
  "//:postMerge",
  "//:prReview",
  "//:preCommit",
  "//:prePush",
  "//:retainCommit",
  "//:syncEnv",
  // .github/PACKAGE.ts
  "//.github:ci",
  "//.github:danger",
  "//.github:dangerCi",
  "//.github:github",
  "//.github:pr",
  "//.github:review",
  // .storybook/PACKAGE.ts
  "//.storybook:storybook",
  "//.storybook:storybookBuild",
  // data/PACKAGE.ts
  "//data:schema",
  "//data:syncSchema",
  "//data:syncSchemaLocal",
  // patches/PACKAGE.ts
  "//patches:patches",
  "//patches:prepare",
  // playwright/PACKAGE.ts
  "//playwright:e2e",
  "//playwright:smoke",
  // src/PACKAGE.ts
  "//src:agentLints",
  "//src:analyticsLint",
  "//src:build",
  "//src:buildClient",
  "//src:buildClientDev",
  "//src:buildServer",
  "//src:buildServerDev",
  "//src:bundleReportClient",
  "//src:bundleReportServer",
  "//src:bundleStats",
  "//src:clean",
  "//src:cleanRelay",
  "//src:conventionsLint",
  "//src:deadCode",
  "//src:dev",
  "//src:format",
  "//src:formatProject",
  "//src:importGraph",
  "//src:jestDebug",
  "//src:lint",
  "//src:openConsentModal",
  "//src:preDeploy",
  "//src:publishAssets",
  "//src:publishAssetsLocal",
  "//src:relay",
  "//src:relayArtifacts",
  "//src:relayLint",
  "//src:routesGen",
  "//src:ruleOfThree",
  "//src:scan",
  "//src:srcs",
  "//src:ssrLint",
  "//src:startProd",
  "//src:startProdDebug",
  "//src:test",
  "//src:testAccuracyLint",
  "//src:typeCheck",
  "//src:unreachableCode",
  // src/Server/PACKAGE.ts
  "//src/Server:srcs",
  "//src/Server:test",
  // src/Apps/*/PACKAGE.ts
  "//src/Apps/Auction:srcs",
  "//src/Apps/Auction:test",
  "//src/Apps/Order2:srcs",
  "//src/Apps/Order2:test",
  "//src/Apps/Settings:srcs",
  "//src/Apps/Settings:test",
  // workflows/*/PACKAGE.ts
  "//workflows/adding-a-new-app-route:addAppRoute",
  "//workflows/beep:beep",
  "//workflows/fix-sentry-issue:fixSentryIssue"
].sort()

const errorCode = async (work: () => Promise<unknown>): Promise<PackageError["code"]> => {
  try {
    await work()
  } catch (cause) {
    if (isPackageError(cause)) return cause.code
    throw cause
  }
  throw new Error("expected a PackageError")
}

const workspaceModule = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  agents: S.Agents({ luna: S.Agent.Codex({ model: "luna" }) }),
})
`

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-package-routing-"))))

describe("force-spec routing", () => {
  it("indexes the complete golden label list and nothing else", async () => {
    const index = await openIndex(forceSpec)
    expect(index.targets().map((row) => row.label)).toEqual(goldenLabels)
  })

  /**
   * The class documents itself as immutable and used to store, and hand back,
   * the caller's live row array. `ReadonlyArray` is erased at runtime, so a
   * spliced row would have left subtree resolution and edge computation
   * reading one set of rows while exact resolution still consulted the
   * separately built label map: two answers from one index.
   */
  it("hands back rows a caller cannot mutate", async () => {
    const index = await openIndex(forceSpec)
    const rows = index.targets() as unknown as Array<{ label: string }>
    const before = rows.map((row) => row.label)

    expect(() => rows.splice(0, 1)).toThrow(TypeError)
    expect(() => rows.push({ label: "//injected:target" })).toThrow(TypeError)
    expect(() => {
      rows[0]!.label = "//renamed:target"
    }).toThrow(TypeError)

    expect(index.targets().map((row) => row.label)).toEqual(before)
    // Exact resolution and subtree resolution still agree on the same row.
    const [exact] = index.resolve("//src:relayArtifacts")
    expect(exact).toBeDefined()
    expect(index.resolve("//...").filter((row) => row.label === "//src:relayArtifacts")).toEqual([exact])
  })

  it("classifies data, gates, and services edges", async () => {
    const index = await openIndex(forceSpec)
    const edges = index.edges(index.resolve("//..."))
    expect(edges).toContainEqual({ from: "//playwright:smoke", to: "//src:dev", kind: "services" })
    expect(edges).toContainEqual({ from: "//playwright:smoke", to: "//playwright:e2e", kind: "data" })
    expect(edges.some((edge) => edge.from === "//:preCommit" && edge.to === "//src:lint")).toBe(true)
    expect(edges).toContainEqual({ from: "//src:relayArtifacts", to: "//data:schema", kind: "data" })
    expect(edges).toContainEqual({ from: "//.github:pr", to: "//:prePush", kind: "gates" })
  })

  it("shares one target identity across importing packages", async () => {
    const index = await openIndex(forceSpec)
    const [auctionTest] = index.resolve("//src/Apps/Auction:test")
    const [relayArtifacts] = index.resolve("//src:relayArtifacts")
    const direct = Target.metadata(auctionTest!.target).dependencies
    expect(direct).toContain(relayArtifacts!.target)
    expect(index.labelOf(relayArtifacts!.target)).toBe("//src:relayArtifacts")
  })

  it("keeps omitted locals unlabeled but owner-bound", async () => {
    const index = await openIndex(forceSpec)
    await expect(async () => index.resolve("//.storybook:storiesGraph")).rejects.toThrow(/unknown_label/)
    const [storybook] = index.resolve("//.storybook:storybook")
    const privateDependency = Target.metadata(storybook!.target).dependencies.find(
      (dependency) => index.labelOf(dependency) === undefined
    )
    expect(privateDependency).toBeDefined()
    expect(index.ownerOf(privateDependency!)).toBe(".storybook")
  })

  it("resolves a recursive pattern narrowed to one target name", async () => {
    // The Bazel-natural spelling of a per-package matrix: the packages opt in
    // by declaring the key and the pattern names the key, so nothing central
    // lists which packages are in. `ci/PACKAGE.ts` used to be that list.
    const index = await openIndex(forceSpec)
    const named = index.resolve("//src/...:test")
    expect(named.map((row) => row.label)).toEqual([
      "//src/Apps/Auction:test",
      "//src/Apps/Order2:test",
      "//src/Apps/Settings:test",
      "//src/Server:test",
      "//src:test"
    ])
    expect(named.every((row) => row.key === "test")).toBe(true)
    // The narrowed pattern is a strict subset of the unnarrowed one.
    const all = index.resolve("//src/...")
    expect(all.length).toBeGreaterThan(named.length)
    for (const row of named) expect(all).toContainEqual(row)
    // And the root pattern narrows the same way, reaching every package.
    const fromRoot = index.resolve("//...:test")
    expect(fromRoot.every((row) => row.key === "test")).toBe(true)
    for (const row of named) expect(fromRoot).toContainEqual(row)
  })

  it("refuses a recursive pattern whose target name nothing declares", async () => {
    // A bare subtree may legitimately select nothing; a caller who named a
    // target meant to run something, so a typo is an error rather than an
    // empty, green run.
    const index = await openIndex(forceSpec)
    expect(await errorCode(async () => index.resolve("//src/...:bunTest"))).toBe("unknown_label")
    await expect(async () => index.resolve("//src/...:bunTest")).rejects.toThrow(/no target named bunTest/)
  })

  it("resolves a bare package only through an explicit default key", async () => {
    const index = await openIndex(forceSpec)
    await expect(async () => index.resolve("//data")).rejects.toThrow(/no_default_target/)
  })

  it("binds git hooks to the indexed root targets", async () => {
    const discovery = await PackageDiscovery.discover(forceSpec)
    const loaded = await PackageLoader.load(discovery)
    const index = PackageIndex.make(loaded)
    const [preCommit] = index.resolve("//:preCommit")
    expect(loaded.workspace.gitHooks?.preCommit).toBe(preCommit!.target)
  })
})

describe("ignore-blind discovery", () => {
  it("indexes a gitignored PACKAGE.ts like any other, with no git repository at all", async () => {
    const root = await temporaryWorkspace()
    await write(root, ".gitignore", "generated/\n")
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "generated/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo generated" }) } })
`
    )
    const index = await openIndex(root)
    expect(index.targets().map((row) => row.label)).toEqual(["//generated:run"])
  })

  it("never descends into a nested checkout, whether a repository or a linked worktree", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { root: S.Shell.Test({ shell: "true" }) } })\n`
    )
    // A linked worktree carries a `.git` FILE; a clone carries a directory.
    // Both hold another tree's declarations, including old-form ones.
    await write(root, "scratch/worktree/.git", "gitdir: /elsewhere/.git/worktrees/worktree\n")
    await write(root, "scratch/worktree/BUILD.ts", "export const stale = 1\n")
    await write(root, "scratch/worktree/pkg/PACKAGE.ts", "export const Package = 1\n")
    await write(root, "vendor/clone/.git/HEAD", "ref: refs/heads/main\n")
    await write(root, "vendor/clone/WORKSPACE.ts", workspaceModule)
    const index = await openIndex(root)
    expect(index.targets().map((row) => row.label)).toEqual(["//:root"])
  })

  it("refuses package files owned by an undeclared nested workspace", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { root: S.Shell.Test({ shell: "true" }) } })\n`
    )
    await write(root, "demo/WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "demo/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { nested: S.Shell.Test({ shell: "true" }) } })\n`
    )
    await expect(openIndex(root)).rejects.toMatchObject({ code: "nested_workspace_undeclared" })
  })

  it("keeps packages under the .smithers directory that holds this workspace's own descriptor", async () => {
    const root = await temporaryWorkspace()
    await write(root, ".smithers/WORKSPACE.ts", workspaceModule)
    await write(
      root,
      ".smithers/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"\nexport const Package = S.Package({ targets: { own: S.Shell.Test({ shell: "true" }) } })\n`
    )
    expect((await openIndex(root)).targets().map((row) => row.label)).toEqual(["//.smithers:own"])
  })
})

describe("error fixtures", () => {
  it("fails a case-fold key collision as duplicate labels", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const a = S.Shell.Run({ shell: "echo a" })
const b = S.Shell.Run({ shell: "echo b" })
export const Package = S.Package({ targets: { Foo: a, foo: b } })
`
    )
    expect(await errorCode(() => openIndex(root))).toBe("case_collision")
  })

  it("fails one value under two labels", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const a = S.Shell.Run({ shell: "echo a" })
export const Package = S.Package({ targets: { first: a, second: a } })
`
    )
    expect(await errorCode(() => openIndex(root))).toBe("target_multiple_labels")
  })

  it("fails a Package import cycle with the chain", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "a/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { Package as b } from "../b/PACKAGE.js"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo a" }) } })
`
    )
    await write(
      root,
      "b/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { Package as a } from "../a/PACKAGE.js"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo b" }) } })
`
    )
    try {
      await openIndex(root)
      throw new Error("expected package_import_cycle")
    } catch (cause) {
      if (!isPackageError(cause)) throw cause
      expect(cause.code).toBe("package_import_cycle")
      expect(cause.chain).toBeDefined()
      expect(cause.chain!.length).toBeGreaterThanOrEqual(3)
    }
  })

  it("fails a naked target export", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const leaked = S.Shell.Run({ shell: "echo leak" })
export const Package = S.Package({ targets: {} })
`
    )
    expect(await errorCode(() => openIndex(root))).toBe("naked_target_export")
  })

  it("rejects a symlinked PACKAGE.ts outright", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "real/actual.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {} })
`
    )
    await Fs.mkdir(NodePath.join(root, "linked"), { recursive: true })
    await Fs.symlink(NodePath.join(root, "real/actual.ts"), NodePath.join(root, "linked/PACKAGE.ts"))
    expect(await errorCode(() => openIndex(root))).toBe("module_not_regular")
  })

  it("fails a bare package with no default key", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "tools/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo run" }) } })
`
    )
    const index = await openIndex(root)
    expect(await errorCode(async () => index.resolve("//tools"))).toBe("no_default_target")
    const [byDefault] = index.resolve("//tools:run")
    expect(byDefault!.label).toBe("//tools:run")
  })

  it("fails an unknown S.Agents name at graph load", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const review = S.Agent.Lint({
  agent: S.Agents.nosuch,
  prompt: S.file("//review.md"),
  data: [S.gitDiff()],
})
export const Package = S.Package({ targets: { review } })
`
    )
    expect(await errorCode(() => openIndex(root))).toBe("unknown_agent")
  })

  it("fails a Package module importing WORKSPACE.ts", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { Workspace } from "./WORKSPACE.js"
export const Package = S.Package({ targets: {} })
`
    )
    expect(await errorCode(() => openIndex(root))).toBe("unsupported_module_specifier")
  })

  it("fails a helper module importing WORKSPACE.ts, naming the helper", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(root, "util.ts", `import { Workspace } from "./WORKSPACE.js"\nexport const name = Workspace\n`)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { name } from "./util.js"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo hi" }) } })
`
    )
    try {
      await openIndex(root)
      throw new Error("expected unsupported_module_specifier")
    } catch (cause) {
      if (!isPackageError(cause)) throw cause
      expect(cause.code).toBe("unsupported_module_specifier")
      expect(cause.path).toBe("util.ts")
    }
  })

  it("fails a cycle routed through a helper module with the full chain", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "a/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { helper } from "./util.js"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: helper }) } })
`
    )
    await write(
      root,
      "a/util.ts",
      `import { Package as b } from "../b/PACKAGE.js"
export const helper = "echo a"
`
    )
    await write(
      root,
      "b/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { Package as a } from "../a/PACKAGE.js"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo b" }) } })
`
    )
    try {
      await openIndex(root)
      throw new Error("expected package_import_cycle")
    } catch (cause) {
      if (!isPackageError(cause)) throw cause
      expect(cause.code).toBe("package_import_cycle")
      expect(cause.chain).toContain("a/util.ts")
      expect(cause.chain).toContain("a/PACKAGE.ts")
      expect(cause.chain).toContain("b/PACKAGE.ts")
    }
  })

  it("fails a case-mismatched Package import before it can mint a second instance", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "sub/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { srcs: S.Shell.Run({ shell: "echo srcs" }) } })
`
    )
    await write(
      root,
      "other/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { Package as sub } from "../Sub/PACKAGE.js"
export const Package = S.Package({ targets: { check: S.Shell.Test({ shell: "echo check", data: [sub.srcs] }) } })
`
    )
    try {
      await openIndex(root)
      throw new Error("expected case_collision")
    } catch (cause) {
      if (!isPackageError(cause)) throw cause
      expect(cause.code).toBe("case_collision")
      expect(cause.path).toBe("other/PACKAGE.ts")
      expect(cause.message).toContain("Sub/PACKAGE.ts")
    }
  })

  it("ignores import specifiers inside comments and ordinary strings", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "a/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
// TODO: reuse the shared srcs from "../b/PACKAGE.js" once it stabilizes
/* also never read from "./WORKSPACE.js" here */
const note = 'not an import from "../b/PACKAGE.js"'
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: note }) } })
`
    )
    await write(
      root,
      "b/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { Package as a } from "../a/PACKAGE.js"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo b" }) } })
`
    )
    const index = await openIndex(root)
    expect(index.targets().map((row) => row.label)).toEqual(["//a:run", "//b:run"])
  })

  it("surfaces the author's declaration error, not a WORKSPACE.ts-blaming generic", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { dev: S.Shell.Serve({ shell: "yarn start", readiness: { http: "/health" } }) } })
`
    )
    try {
      await openIndex(root)
      throw new Error("expected module_import_failed")
    } catch (cause) {
      if (!isPackageError(cause)) throw cause
      expect(cause.code).toBe("module_import_failed")
      expect(cause.message).toMatch(/Shell\.Serve declaration/)
      expect(cause.message).toMatch(/PACKAGE\.ts:\d+/)
      expect(cause.message).not.toContain("[WORKSPACE.ts]")
    }
  })
})

describe("helper modules and the load cache", () => {
  it("re-keys the per-process load when an imported helper changes", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(root, "util.ts", `export const commandText = "echo first"\n`)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
import { commandText } from "./util.js"

export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: commandText }) } })
`
    )
    const first = await openIndex(root)
    const [firstRun] = first.resolve("//:run")
    expect((Target.metadata(firstRun!.target).attrs as { shell?: string }).shell).toBe("echo first")
    await write(root, "util.ts", `export const commandText = "echo second"\n`)
    const second = await openIndex(root)
    const [secondRun] = second.resolve("//:run")
    expect((Target.metadata(secondRun!.target).attrs as { shell?: string }).shell).toBe("echo second")
  })
})

describe("edge classification through nested private locals", () => {
  it("keeps the entry attr's kind across two levels of omitted helpers", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const leaf = S.Shell.Test({ shell: "echo leaf" })
const privateInner = S.Suite({ tests: [S.Shell.Test({ shell: "echo t", data: [leaf] })] })
const privateOuter = S.Suite({ tests: [privateInner] })
const top = S.Shell.Run({ shell: "echo top", data: [privateOuter] })
export const Package = S.Package({ targets: { top, leaf } })
`
    )
    const index = await openIndex(root)
    const edges = index.edges(index.resolve("//:top"))
    expect(edges).toContainEqual({ from: "//:top", to: "//:leaf", kind: "data" })
    expect(edges.filter((edge) => edge.to === "//:leaf").map((edge) => edge.kind)).not.toContain("deps")
  })
})

describe("current package outside the workspace", () => {
  it("resolves absolute patterns and refuses only relative labels", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { run: S.Shell.Run({ shell: "echo hi" }) } })
`
    )
    const discovery = await PackageDiscovery.discover(root)
    const loaded = await PackageLoader.load(discovery)
    const outside = PackageIndex.make(loaded, NodePath.parse(root).root)
    expect(outside.currentPackage).toBeUndefined()
    expect(outside.resolve("//...").map((row) => row.label)).toEqual(["//:run"])
    expect(outside.resolve("//:run")).toHaveLength(1)
    expect(await errorCode(async () => outside.resolve(":run"))).toBe("unknown_label")
  })
})
