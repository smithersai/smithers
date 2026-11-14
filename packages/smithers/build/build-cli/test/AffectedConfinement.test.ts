import { Smithers as S } from "@smthrs/targets"
import type * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, expect, it } from "vitest"
import * as Affected from "../src/Affected.ts"
import { plan } from "../src/internal/PackagePlanner.ts"
import * as RulePolicy from "../src/internal/RulePolicy.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import { productionSourceRoots } from "../src/Planner.ts"
import { causes } from "./helpers/AffectedExplain.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const fixture = async (
  targets: Readonly<Record<string, Target.AnyTarget>>,
  mechanism: "enforced" | "none" | "absent" | "unsupported" = "enforced",
  packagePath = "pkg",
  repository?: string
) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-affected-inputs-")))
  roots.push(root)
  await write(root, "package.json", "{}")
  await write(root, "yarn.lock", "")
  await write(root, `${packagePath}/PACKAGE.ts`, "")
  await write(root, `${packagePath}/declared.txt`, "declared")
  await write(root, `${packagePath}/secret.txt`, "private sibling")
  const packageJson = S.file("//package.json")
  const workspace = S.Workspace("fixture", {
    repository: "git+https://example.invalid/fixture.git",
    cache: S.Cache({ directory: ".flows" }),
    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
    packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
    nodeModules: S.Npm.NodeModules({ packageJson }),
    ...(repository === undefined ? {} : { repos: { vendor: S.LocalRepository(repository) } }),
    ...(mechanism === "absent" ? {} : {
      sandboxes: S.Sandboxes({
        default: mechanism === "none"
          ? S.Sandbox.None()
          : mechanism === "unsupported"
          ? S.Sandbox.Microsandbox()
          : S.Sandbox.Bubblewrap()
      })
    })
  })
  const index = PackageIndex.make({
    root,
    workspace,
    factory: undefined,
    packages: [{ file: `${packagePath}/PACKAGE.ts`, packagePath, value: S.Package({ targets }) }]
  })
  const inspect = () => plan({ index, cacheDirectory: ".flows", verb: "auto", patterns: ["//..."] })
  return { root, index, inspect }
}

it.each(["default", "closed", "network", "none"] as const)(
  "uses the resolved %s process policy without losing declared-input reasons",
  async (policy) => {
    const check = S.Shell.Test({
      shell: "true",
      data: [S.file("declared.txt")],
      ...(policy === "default" ? {} : { sandbox: policy === "none" ? "none" : { network: policy === "network" } })
    })
    const { index, inspect } = await fixture({ check })
    const planned = await inspect()
    expect(planned.nodes.get("//pkg:check")!.sandbox).toEqual(
      policy === "default" ? undefined : policy === "none" ? "none" : { network: policy === "network" }
    )
    const sibling = Affected.select(index, ["//..."], ["pkg/secret.txt"], { explain: true })
    expect(sibling.conservative).toBe(false)
    expect(sibling.targets.map((target) => target.label)).toEqual(policy === "none" ? ["//pkg:check"] : [])
    if (policy === "none") {
      expect(causes(sibling, sibling.targets[0]!.label)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "package", label: "//pkg:check" })
      ]))
    }
    const declared = Affected.select(index, ["//..."], ["pkg/declared.txt"], { explain: true })
    expect(declared.targets).toHaveLength(1)
    expect(causes(declared, declared.targets[0]!.label)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "declared-input", input: S.file("declared.txt") })
    ]))
    expect(causes(declared, declared.targets[0]!.label).some((cause) => cause.kind === "package")).toBe(
      policy === "none"
    )
  }
)

it.each(["none", "absent"] as const)("keeps package selection with a %s workspace mechanism", async (mechanism) => {
  const { index } = await fixture({
    check: S.Shell.Test({ shell: "true", data: [S.file("declared.txt")], sandbox: {} })
  }, mechanism)
  const selected = Affected.select(index, ["//..."], ["pkg/secret.txt"], { explain: true })
  expect(selected.targets).toEqual([{ label: "//pkg:check", sources: [0] }])
  expect(causes(selected, "//pkg:check")).toMatchObject([{ kind: "package" }])
})

it.each(["enforced", "none", "absent"] as const)(
  "does not propagate an excluded Filegroup sibling with mechanism %s",
  async (mechanism) => {
    const sources = S.Filegroup({ srcs: [S.glob("**/*.txt", { exclude: ["secret.txt"] })] })
    const nested = S.Filegroup({ srcs: [sources] })
    const check = S.Shell.Test({ shell: "true", data: [nested] })
    const { index, root } = await fixture({ sources, nested, check }, mechanism)
    // The consumer is in a different package; its own unconfined package
    // fallback must not disguise a spurious Filegroup dependency cause.
    await write(root, "consumer/PACKAGE.ts", "")
    const consumerIndex = PackageIndex.make({
      root,
      workspace: index.workspace,
      factory: undefined,
      packages: [
        { file: "pkg/PACKAGE.ts", packagePath: "pkg", value: S.Package({ targets: { sources, nested } }) },
        { file: "consumer/PACKAGE.ts", packagePath: "consumer", value: S.Package({ targets: { check } }) }
      ]
    })
    expect(Affected.select(consumerIndex, ["//consumer:check"], ["pkg/secret.txt"])).toMatchObject({
      conservative: false,
      targets: []
    })
    expect(Affected.select(consumerIndex, ["//consumer:check"], ["pkg/declared.txt"]).targets).toMatchObject([
      { label: "//consumer:check", reasons: ["pkg/declared.txt"] }
    ])
  }
)

it("retains global, unknown, empty and uncacheable fallbacks under confinement", async () => {
  const { index } = await fixture({
    check: S.Shell.Test({ shell: "true", data: [S.file("declared.txt")] }),
    files: S.Filegroup({ srcs: [S.file("declared.txt")] }),
    run: S.Shell.Run({ shell: "true", data: [S.file("declared.txt")] }),
    empty: S.Filegroup({ srcs: [] })
  })
  for (const file of ["pkg/PACKAGE.ts", "unknown/file.txt"]) {
    expect(Affected.select(index, ["//..."], [file])).toMatchObject({ conservative: true })
    expect(Affected.select(index, ["//..."], [file]).targets).toHaveLength(4)
  }
  const selected = Affected.select(index, ["//..."], ["pkg/secret.txt"], { explain: true })
  expect(selected.targets.map((target) => target.label).sort()).toEqual(["//pkg:empty", "//pkg:run"])
  expect(causes(selected, "//pkg:run"))
    .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "uncacheable" })]))
})

it.each(["enforced", "none"] as const)(
  "selects a superset of real planned key changes across generated trees (%s)",
  async (mechanism) => {
    // Deterministic generator: retain the seed and sample number in failures.
    let state = 0x51a7c0de
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state
    }
    let changedKeys = 0
    let stableKeys = 0
    for (let sample = 0; sample < 12; sample++) {
      const packageName = `package${next() % 4}`
      const file = sample % 3 === 0 ? "new.txt" : `f${next() % 5}.txt`
      const sources = S.Filegroup({
        srcs: [S.glob("*.txt", { exclude: [`f${next() % 5}.txt`, "secret.txt"] })]
      })
      const targets: Record<string, Target.AnyTarget> = { sources }
      for (let target = 0; target < 4; target++) {
        const inputs = Array.from({ length: 5 }, (_, i) => i)
          .filter((i) => next() % 3 === 0 && !(sample % 3 === 2 && `f${i}.txt` === file))
          .map((i) => S.file(`f${i}.txt`))
        targets[`t${target}`] = S.Shell.Test({
          shell: "true",
          sandbox: next() % 3 === 0 ? "none" : {},
          data: [...inputs, ...(next() % 2 === 0 ? [sources] : [])]
        })
      }
      const { root, index } = await fixture(targets, mechanism, packageName)
      const consumerPath = `consumer${next() % 4}`
      await write(root, `${consumerPath}/PACKAGE.ts`, "")
      const consumer = S.Shell.Test({ shell: "true", data: [sources], sandbox: {} })
      const generated = PackageIndex.make({
        root,
        workspace: index.workspace,
        factory: undefined,
        packages: [
          { file: `${packageName}/PACKAGE.ts`, packagePath: packageName, value: S.Package({ targets }) },
          { file: `${consumerPath}/PACKAGE.ts`, packagePath: consumerPath, value: S.Package({ targets: { consumer } }) }
        ]
      })
      const inspect = () => plan({ index: generated, cacheDirectory: ".flows", verb: "auto", patterns: ["//..."] })
      for (let i = 0; i < 5; i++) await write(root, `${packageName}/f${i}.txt`, "before")
      const before = await inspect()
      if (sample % 3 === 2) await Fs.unlink(Path.join(root, packageName, file))
      else await write(root, `${packageName}/${file}`, `after-${sample}`)
      const after = await inspect()
      const selected = new Set(
        Affected.select(generated, ["//..."], [`${packageName}/${file}`]).targets.map((row) => row.label)
      )
      for (const [label, node] of after.nodes) {
        expect(node.refusal, `sample ${sample} ${label}`).toBeUndefined()
        if (node.keyPreview !== before.nodes.get(label)!.keyPreview) {
          changedKeys++
          expect(selected.has(label), `seed 0x51a7c0de sample ${sample} ${label} changed key for ${file}`).toBe(true)
        } else stableKeys++
      }
    }
    expect(changedKeys).toBeGreaterThan(0)
    expect(stableKeys).toBeGreaterThan(0)
  },
  300_000
)

it.runIf(process.platform === "linux")("an unselected confined target cannot read the changed sibling", async () => {
  const { root, index } = await fixture({
    denied: S.Shell.Test({ shell: "cat pkg/secret.txt", data: [S.file("declared.txt")], sandbox: {} }),
    admitted: S.Shell.Test({ shell: "cat pkg/declared.txt", data: [S.file("declared.txt")], sandbox: {} })
  })
  await write(root, "pkg/secret.txt", "changed private sibling")
  expect(Affected.select(index, ["//pkg:denied"], ["pkg/secret.txt"]).targets).toEqual([])
  const logs: Array<string> = []
  const run = (label: string) =>
    PackageExec.run({
      index,
      cacheDirectory: ".flows",
      verb: "test",
      patterns: [label],
      readCache: false,
      jobs: 1,
      log: (line) => logs.push(line)
    })
  const denied = await run("//pkg:denied")
  expect(denied.ok, JSON.stringify(denied)).toBe(false)
  expect(JSON.stringify(denied) + logs.join("\n")).toMatch(
    /secret.txt.*outside the declared read set|No such file|Permission denied/
  )
  const admitted = await run("//pkg:admitted")
  expect(admitted.ok, JSON.stringify(admitted)).toBe(true)
  expect(await Fs.readFile(Path.join(root, "pkg/secret.txt"), "utf8")).toBe("changed private sibling")
})

it("does not consult host availability for a mechanism that fails closed", async () => {
  const { index } = await fixture({
    check: S.Shell.Test({ shell: "true", data: [S.file("declared.txt")], sandbox: {} })
  }, "unsupported")
  expect(Affected.select(index, ["//..."], ["pkg/secret.txt"]).targets).toEqual([])
})

it("retains package selection if any executable kind opts out", () => {
  const enforced = S.Sandboxes({ default: S.Sandbox.Bubblewrap() })
  expect(RulePolicy.readsPackage("Shell.Test", [{ sandbox: {} }, { sandbox: "none" }], enforced)).toBe(true)
  expect(RulePolicy.readsPackage("Shell.Test", [{ sandbox: { network: "loopback" } }], enforced)).toBe(false)
  expect(RulePolicy.readsPackage("Unknown.Rule", [{ sandbox: {} }], enforced)).toBe(true)
})

it.each(
  [
    ["Anvil.Fork", "none", { network: true }],
    ["Fetch", "none", { network: true }],
    ["Git.Submodule", undefined, { network: true }],
    ["Git.Submodules", {}, { network: true }],
    ["Npm.Published", "none", { network: true }],
    ["Docker.Serve", {}, "none"],
    ["Docker.Service", { network: true }, "none"],
    ["Docker.Build", undefined, "none"],
    ["Docker.Bake", {}, {}],
    ["Docker.Push", "none", "none"]
  ] as const
)("keeps intrinsic %s policy overrides", (rule, declared, expected) => {
  expect(RulePolicy.sandbox(rule, declared)).toEqual(expected)
})

it("lists only declared causes at the CLI boundary", async () => {
  const { root } = await fixture({})
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.Bubblewrap() })
})`
  )
  await write(
    root,
    "pkg/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  check: S.Shell.Test({ shell: "true", sandbox: {}, data: [S.file("declared.txt")] })
} })`
  )
  for (const file of ["pkg/declared.txt", "pkg/secret.txt"]) {
    const result = await serve(root, ["affected", "test", "//...", "--files", file, "--list", "--json"])
    expect(result.exitCode, result.output + result.logs).toBe(0)
    const listed = JSON.parse(result.output)
    expect(listed.conservative).toBe(false)
    const { changeSets, changes, edges, sources, targets } = listed
    expect({ targets, sources, changeSets, changes, edges }).toEqual(
      file === "pkg/secret.txt" ? { targets: [], sources: [], changeSets: [], changes: [], edges: {} } : {
        targets: [{ label: "//pkg:check", sources: [0] }],
        sources: [{ label: "//pkg:check", rule: "Shell.Test", changes: [0] }],
        changeSets: [[0]],
        changes: [{ file: "pkg/declared.txt", kind: "declared-input", input: S.file("declared.txt") }],
        edges: {}
      }
    )
  }
})

it.each(["", "./", "../escape", "/absolute", "pkg/../escape"])(
  "refuses invalid changed path %s before applying confinement policy",
  async (path) => {
    const { index } = await fixture({ check: S.Shell.Test({ shell: "true", data: [S.file("declared.txt")] }) })
    expect(() => Affected.select(index, ["//..."], [path])).toThrow("invalid workspace-relative changed path")
  }
)

it.each([
  { outFiles: ["result.txt"] },
  { outFiles: ["//result.txt"] },
  { outDirs: ["."] },
  { outDirs: ["//other"] }
])("keeps reads admitted by output mounts: %j", async (outputs) => {
  const { root, index } = await fixture({
    build: S.Shell.Build({ shell: "true", data: [S.file("declared.txt")], sandbox: {}, ...outputs })
  })
  await write(root, "other/PACKAGE.ts", "")
  const source = S.Filegroup({ srcs: [S.file("input.txt")] })
  const expanded = PackageIndex.make({
    root,
    workspace: index.workspace,
    factory: undefined,
    packages: [
      {
        file: "pkg/PACKAGE.ts",
        packagePath: "pkg",
        value: S.Package({
          targets: {
            build: index.resolve("//pkg:build")[0]!.target
          }
        })
      },
      { file: "other/PACKAGE.ts", packagePath: "other", value: S.Package({ targets: { source } }) }
    ]
  })
  const path = "outDirs" in outputs && outputs.outDirs[0] === "//other" ? "other/input.txt" : "pkg/secret.txt"
  const explained = Affected.select(expanded, ["//pkg:build"], [path], { explain: true })
  expect(explained.targets.map((target) => target.label)).toEqual(["//pkg:build"])
  expect(causes(explained, "//pkg:build")).toEqual([expect.objectContaining({ kind: "sandbox-input" })])
})

it("keeps workspace cache and dependency-directory read grants", async () => {
  const { index } = await fixture({
    check: S.Shell.Test({ shell: "true", data: [S.file("declared.txt")], sandbox: {} })
  })
  for (const file of ["pkg/node_modules/library/index.js", ".flows/tmp/input.txt"]) {
    expect(Affected.select(index, ["//pkg:check"], [file]).targets).toHaveLength(1)
  }
})

it.runIf(process.platform === "linux")("selects a confined build that can read an output file's sibling", async () => {
  const { index } = await fixture({
    build: S.Shell.Build({
      shell: "cat pkg/secret.txt > pkg/result.txt",
      data: [S.file("declared.txt")],
      outFiles: ["result.txt"],
      sandbox: {}
    })
  })
  expect(Affected.select(index, ["//pkg:build"], ["pkg/secret.txt"]).targets).toHaveLength(1)
  const result = await PackageExec.run({
    index,
    cacheDirectory: ".flows",
    verb: "build",
    patterns: ["//pkg:build"],
    readCache: false,
    jobs: 1
  })
  expect(result.ok, JSON.stringify(result)).toBe(true)
})

it.each(["[x]", "literal*", "brace{a,b}"])("matches literal readable directory %s", async (directory) => {
  const { index } = await fixture({
    build: S.Shell.Build({
      shell: "true",
      data: [S.file("declared.txt")],
      sandbox: {},
      outFiles: [directory + "/result.txt"]
    })
  })
  expect(Affected.select(index, ["//pkg:build"], ["pkg/" + directory + "/secret.txt"]).targets).toHaveLength(1)
})

it.each(["file", "parent", "glob"] as const)("selects real planned key changes behind a %s symlink", async (mode) => {
  const sources = S.Filegroup({
    srcs: [mode === "glob" ? S.glob("alias*.txt") : S.file(mode === "parent" ? "alias/secret.txt" : "alias.txt")]
  })
  const { root, index, inspect } = await fixture({
    sources,
    check: S.Shell.Test({ shell: "true", data: [sources], sandbox: {} })
  })
  if (mode === "parent") {
    await write(root, "pkg/real/secret.txt", "before")
    await Fs.symlink("real", Path.join(root, "pkg/alias"), "dir")
  } else await Fs.symlink("secret.txt", Path.join(root, "pkg/alias.txt"))
  const before = await inspect()
  const file = mode === "parent" ? "pkg/real/secret.txt" : "pkg/secret.txt"
  await write(root, file, "after")
  const after = await inspect()
  expect(after.nodes.get("//pkg:check")!.keyPreview).not.toBe(before.nodes.get("//pkg:check")!.keyPreview)
  expect(Affected.select(index, ["//pkg:check"], [file]).targets).toHaveLength(1)
})

it("keys and selects a nonstandard workspace lockfile name", async () => {
  const { root, index } = await fixture({
    check: S.Shell.Test({ shell: "true", data: [S.file("declared.txt")], sandbox: {} })
  })
  const packageJson = S.file("//package.json")
  const workspace = S.Workspace("fixture", {
    repository: "git+https://example.invalid/fixture.git",
    cache: S.Cache({ directory: ".flows" }),
    runtime: S.Runtime.Node({ version: ">=26.4.0" }),
    packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//pkg/deps.data") }),
    nodeModules: S.Npm.NodeModules({ packageJson }),
    sandboxes: S.Sandboxes({ default: S.Sandbox.Bubblewrap() })
  })
  const expanded = PackageIndex.make({
    root,
    workspace,
    factory: undefined,
    packages: [
      {
        file: "pkg/PACKAGE.ts",
        packagePath: "pkg",
        value: S.Package({ targets: { check: index.resolve("//pkg:check")[0]!.target } })
      }
    ]
  })
  await write(root, "pkg/deps.data", "before")
  const inspect = () => plan({ index: expanded, cacheDirectory: ".flows", verb: "auto", patterns: ["//..."] })
  const before = await inspect()
  await write(root, "pkg/deps.data", "after")
  const after = await inspect()
  expect(after.nodes.get("//pkg:check")!.keyPreview).not.toBe(before.nodes.get("//pkg:check")!.keyPreview)
  expect(Affected.select(expanded, ["//pkg:check"], ["pkg/deps.data"]).targets).toHaveLength(1)
})

it.each(["alias.txt", "@(alias).txt", "{alias,other}.txt"])("tracks link inputs in %s", async (pattern) => {
  const { root, index, inspect } = await fixture({ sources: S.Filegroup({ srcs: [S.glob(pattern)] }) })
  await Fs.symlink("secret.txt", Path.join(root, "pkg/alias.txt"))
  const before = await inspect()
  await write(root, "pkg/secret.txt", "changed")
  const after = await inspect()
  expect(after.nodes.get("//pkg:sources")!.keyPreview).not.toBe(before.nodes.get("//pkg:sources")!.keyPreview)
  expect(Affected.select(index, ["//pkg:sources"], ["pkg/secret.txt"]).targets).toHaveLength(1)
})

it("retains aliases of an implicitly admitted dependency directory", async () => {
  const { root, index } = await fixture({
    check: S.Shell.Test({ shell: "true", data: [S.file("declared.txt")], sandbox: {} })
  })
  await write(root, "pkg/deps/library.txt", "dependency")
  await Fs.symlink("deps", Path.join(root, "pkg/node_modules"), "dir")
  expect(Affected.select(index, ["//pkg:check"], ["pkg/deps/library.txt"]).targets).toHaveLength(1)
})

it("retains indirect inputs inside an explicitly entered repository", async () => {
  const sources = S.Filegroup({ srcs: [S.glob("vendor/**/*.txt")] })
  const { root, index, inspect } = await fixture({ sources }, "enforced", "pkg", "pkg/vendor")
  await write(root, "pkg/vendor/sub/PACKAGE.ts", "")
  await Fs.symlink("../../secret.txt", Path.join(root, "pkg/vendor/sub/alias.txt"))
  const before = await inspect()
  await write(root, "pkg/secret.txt", "after")
  const after = await inspect()
  expect(after.nodes.get("//pkg:sources")!.keyPreview).not.toBe(before.nodes.get("//pkg:sources")!.keyPreview)
  expect(Affected.select(index, ["//pkg:sources"], ["pkg/secret.txt"]).targets).toHaveLength(1)
})

it("retains an indirect identity of an explicitly declared installation", async () => {
  const { root, index, inspect } = await fixture({
    check: S.Shell.Test({ shell: "true", sandbox: {}, data: [S.nodeModules("dep")] })
  })
  await write(root, "pkg/dep/pnpm-lock.yaml", "lockfileVersion: '9.0'")
  await write(root, "pkg/identity.txt", "{}")
  await Fs.symlink("../identity.txt", Path.join(root, "pkg/dep/package.json"))
  const before = await inspect()
  await write(root, "pkg/identity.txt", "{\"name\":\"changed\"}")
  const after = await inspect()
  expect(after.nodes.get("//pkg:check")!.keyPreview).not.toBe(before.nodes.get("//pkg:check")!.keyPreview)
  expect(Affected.select(index, ["//pkg:check"], ["pkg/identity.txt"]).targets).toHaveLength(1)
})

it("retains readable aliases of an explicitly declared installation", async () => {
  const { root, index } = await fixture({
    check: S.Shell.Test({ shell: "true", sandbox: {}, data: [S.nodeModules("dep")] })
  })
  await write(root, "pkg/dep/package.json", "{}")
  await write(root, "pkg/dep/pnpm-lock.yaml", "lockfileVersion: '9.0'")
  await write(root, "pkg/deps/library.txt", "dependency")
  await Fs.symlink("../deps", Path.join(root, "pkg/dep/node_modules"), "dir")
  expect(Affected.select(index, ["//pkg:check"], ["pkg/deps/library.txt"]).targets).toHaveLength(1)
  await Fs.unlink(Path.join(root, "pkg/dep/node_modules"))
  await write(root, "pkg/dep/node_modules/library.txt", "dependency")
  expect(Affected.select(index, ["//pkg:check"], ["pkg/dep/node_modules/library.txt"]).targets).toHaveLength(1)
})

it.each(["implicit", "declared"] as const)(
  "keeps unrelated siblings precise with an external %s install",
  async (kind) => {
    const { root, index, inspect } = await fixture({
      check: S.Shell.Test({
        shell: "true",
        sandbox: {},
        data: kind === "declared" ? [S.nodeModules("dep")] : [S.file("declared.txt")]
      })
    })
    const installation = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-external-install-"))
    roots.push(installation)
    await write(installation, "node_modules/library.txt", "dependency")
    const link = kind === "declared" ? "pkg/dep/node_modules" : "pkg/node_modules"
    if (kind === "declared") {
      await write(root, "pkg/dep/package.json", "{}")
      await write(root, "pkg/dep/pnpm-lock.yaml", "lockfileVersion: '9.0'")
    }
    await Fs.symlink(Path.join(installation, "node_modules"), Path.join(root, link), "dir")
    const before = await inspect()
    await write(root, "pkg/secret.txt", "changed sibling")
    const after = await inspect()
    expect(after.nodes.get("//pkg:check")!.keyPreview).toBe(before.nodes.get("//pkg:check")!.keyPreview)
    expect(Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"]).targets).toEqual([])
  }
)

it.each(["missing", "not-directory"] as const)("keeps virtual indexes precise when their root is %s", async (kind) => {
  const check = S.Shell.Test({ shell: "true", sandbox: {}, data: [S.file("declared.txt")] })
  const { root, index } = await fixture({ check })
  const virtualRoot = kind === "missing" ? Path.join(root, "absent") : Path.join(root, "package.json", "child")
  const virtual = PackageIndex.make({
    root: virtualRoot,
    workspace: index.workspace,
    factory: undefined,
    packages: [{ file: "pkg/PACKAGE.ts", packagePath: "pkg", value: S.Package({ targets: { check } }) }]
  })
  expect(Affected.select(virtual, ["//pkg:check"], ["pkg/secret.txt"]).targets).toEqual([])
  expect(Affected.select(virtual, ["//pkg:check"], ["pkg/declared.txt"]).targets.map((row) => row.label))
    .toEqual(["//pkg:check"])
})

it.each(["dangling", "loop"] as const)("retains an indirect-input cause for a %s declared link", async (kind) => {
  const { root, index } = await fixture({
    check: S.Shell.Test({ shell: "true", sandbox: {}, data: [S.file("link/declared.txt")] })
  })
  await Fs.symlink(kind === "loop" ? "link" : "absent", Path.join(root, "pkg/link"), "dir")
  const selection = Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"], { explain: true })
  expect(selection.targets).toHaveLength(1)
  expect(causes(selection, selection.targets[0]!.label)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "indirect-input", input: S.file("link/declared.txt") })
  ]))
})

it("reports a readable installation alias without calling it package ownership", async () => {
  const { root, index } = await fixture({
    check: S.Shell.Test({ shell: "true", sandbox: {}, data: [S.file("declared.txt")] })
  })
  await Fs.mkdir(Path.join(root, "shared"))
  await Fs.symlink("../shared", Path.join(root, "pkg/node_modules"), "dir")
  const selection = Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"], { explain: true })
  expect(causes(selection, selection.targets[0]!.label)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "indirect-input", readPath: "pkg/node_modules" })
  ]))
  expect(causes(selection, selection.targets[0]!.label).some((cause) => cause.kind === "package")).toBe(false)
})

it("keeps a glob conservative when its scan prefix cannot be resolved", async () => {
  const input = S.glob("cycle/**/*.data")
  const { root, index } = await fixture({ check: S.Filegroup({ srcs: [input] }) })
  await Fs.symlink("cycle", Path.join(root, "pkg/cycle"), "dir")
  const selection = Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"], { explain: true })
  expect(causes(selection, selection.targets[0]!.label)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "indirect-input", input })
  ]))
})

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "keeps a glob conservative after a partially readable directory scan",
  async () => {
    const input = S.glob("sources/**/*.data")
    const { root, index } = await fixture({ check: S.Filegroup({ srcs: [input] }) })
    const denied = Path.join(root, "pkg/sources/denied")
    await Fs.mkdir(denied, { recursive: true })
    await Fs.chmod(denied, 0)
    try {
      const selection = Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"], { explain: true })
      expect(causes(selection, selection.targets[0]!.label)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "indirect-input", input })
      ]))
    } finally {
      await Fs.chmod(denied, 0o700)
    }
  }
)

it("omits installation, repository and cache directories from the alias survey", async () => {
  const { root, index } = await fixture({
    check: S.Filegroup({ srcs: [S.glob("//**/*.data"), S.glob("//.flows/**/*.data")] })
  })
  for (const directory of ["node_modules", ".git", ".flows/nested"]) {
    await Fs.mkdir(Path.join(root, directory), { recursive: true })
    await Fs.symlink(Path.join(root, "pkg/declared.txt"), Path.join(root, directory, "alias.data"))
  }
  expect(Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"]).targets).toEqual([])
})

it("keeps a glob conservative when the bounded alias survey is exhausted", async () => {
  const input = S.glob("sources/*.data")
  const { root, index } = await fixture({ check: S.Filegroup({ srcs: [input] }) })
  const directory = Path.join(root, "pkg/sources")
  await Fs.mkdir(directory)
  for (let start = 0; start < 100_001; start += 256) {
    await Promise.all(Array.from(
      { length: Math.min(256, 100_001 - start) },
      (_, offset) => Fs.writeFile(Path.join(directory, `${start + offset}.data`), "")
    ))
  }
  const selection = Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"], { explain: true })
  expect(causes(selection, selection.targets[0]!.label)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "indirect-input", input })
  ]))
})

it("retains implementation directories and their descendants as global inputs", async () => {
  const check = S.Shell.Test({ shell: "true", sandbox: {}, data: [S.file("declared.txt")] })
  const { index } = await fixture({ check })
  const implementation = productionSourceRoots()[0]!.directory
  const root = Path.dirname(Path.dirname(implementation))
  const real = PackageIndex.make({
    root,
    workspace: index.workspace,
    factory: undefined,
    packages: [{ file: "pkg/PACKAGE.ts", packagePath: "pkg", value: S.Package({ targets: { check } }) }]
  })
  const directory = Path.relative(root, implementation).replaceAll("\\", "/")
  for (const path of [directory, directory + "/Affected.ts"]) {
    const selection = Affected.select(real, ["//pkg:check"], [path], { explain: true })
    expect(selection.conservative).toBe(true)
    expect(causes(selection, selection.targets[0]!.label)).toContainEqual({ file: path, kind: "global-input" })
  }
  expect(Affected.select(real, ["//pkg:check"], ["pkg/secret.txt"]).targets).toEqual([])
})

it("selects a confined script by the script's declared file identity", async () => {
  const { root, index, inspect } = await fixture({
    check: S.Shell.Test({ script: S.file("check.mjs"), sandbox: {} })
  })
  await write(root, "pkg/check.mjs", "console.log('first')\n")
  const before = await inspect()
  await write(root, "pkg/check.mjs", "console.log('second')\n")
  const after = await inspect()
  expect(after.nodes.get("//pkg:check")!.keyPreview).not.toBe(before.nodes.get("//pkg:check")!.keyPreview)
  const selected = Affected.select(index, ["//pkg:check"], ["pkg/check.mjs"], { explain: true })
  expect(selected.targets.map((row) => row.label)).toEqual(["//pkg:check"])
  expect(causes(selected, selected.targets[0]!.label)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "declared-input", input: S.file("check.mjs") })
  ]))
  expect(Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"]).targets).toEqual([])
})

it("propagates a confined bin producer's declared input without selecting unrelated siblings", async () => {
  const executable = S.Shell.Build({
    shell: "true",
    data: [S.file("declared.txt")],
    outFiles: ["out/tool"],
    sandbox: {}
  })
  const { root, index, inspect } = await fixture({
    executable,
    check: S.Shell.Test({ bin: executable, sandbox: {} })
  })
  const before = await inspect()
  await write(root, "pkg/declared.txt", "changed executable source")
  const after = await inspect()
  expect(after.nodes.get("//pkg:check")!.keyPreview).not.toBe(before.nodes.get("//pkg:check")!.keyPreview)
  const selected = Affected.select(index, ["//pkg:check"], ["pkg/declared.txt"], { explain: true })
  expect(selected.targets.map((row) => row.label)).toEqual(["//pkg:check"])
  expect(causes(selected, selected.targets[0]!.label).some((cause) => cause.kind === "package")).toBe(false)
  expect(Affected.select(index, ["//pkg:check"], ["pkg/secret.txt"]).targets).toEqual([])
})
