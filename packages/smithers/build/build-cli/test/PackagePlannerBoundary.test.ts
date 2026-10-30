import { Smithers as S } from "@smthrs/targets"
import * as BundlerTarget from "@smthrs/targets/BundlerTarget"
import * as Stamp from "@smthrs/targets/Stamp"
import * as Target from "@smthrs/targets/Target"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Cache from "../src/Cache.ts"
import {
  attrMember,
  collectTagged,
  decodeStoredResolve,
  graphKeySentinel,
  keyMaterialWithGraph,
  parseNameStatusZ,
  planEffect,
  PlanningServices,
  planningServicesLive
} from "../src/internal/PackagePlanner.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import type * as Planner from "../src/Planner.ts"
import * as StampExec from "../src/StampExec.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const fixture = async (
  source: string,
  files: Readonly<Record<string, string>> = {},
  extra = "",
  javascript = true,
  runtime = "S.Runtime.Node({ version: \">=22\" })"
) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-planner-boundary-")))
  roots.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("planner-boundary", {
 repository: "git+https://example.invalid/planner.git", cache: S.Cache({ directory: ".flows" }),
 ${
      javascript ?
        `runtime: ${runtime},
 packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
 nodeModules: S.Npm.NodeModules({ packageJson }),` :
        `toolchains: [S.Rust.Toolchain({ channel: "stable" })],`
    }
 host: S.Host({ bins: ["sh", "bash", "node", "npm", "missing-service-executable", "missing-generator"] }), ${extra}
})`
  )
  await write(
    root,
    "package.json",
    "{\"name\":\"planner-boundary\",\"version\":\"1.0.0\",\"private\":true,\"packageManager\":\"pnpm@11.25.0\"}\n"
  )
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  await write(root, "PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"\n${source}`)
  for (const [path, value] of Object.entries(files)) await write(root, path, value)
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root)
  return { root, options: { index, cacheDirectory: ".flows", verb: "auto" as const, patterns: ["//:command"] } }
}
const declared = (rule: string, attrs: string) =>
  `import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
const command = Target.make(${
    JSON.stringify(rule)
  }, { attrs: Schema.Unknown, kinds: ["build", "test"], implementation: () => Target.notImplemented(${
    JSON.stringify(rule)
  }) })(${attrs})
export const Package = S.Package({ targets: { command } })`

describe("inert planning values", () => {
  it.each([null, 7, {}, { kind: "bundler-resolve", result: {} }])("rejects malformed cached graph %j", (value) => {
    expect(decodeStoredResolve(value)).toBeUndefined()
  })

  it("keeps non-record values intact while substituting graph identities", () => {
    const date = new Date(0), map = new Map([["key", graphKeySentinel]])
    const nil = Object.assign(Object.create(null), { value: graphKeySentinel })
    const material = {
      body: {},
      inputs: {
        attrs: { date, map, nil, list: [graphKeySentinel] },
        dependencies: [{ label: "//:a", key: graphKeySentinel }, { label: "//:b", key: "stable" }]
      },
      toolchain: []
    } as unknown as Planner.KeyMaterial
    const result = keyMaterialWithGraph(material, "resolved")
    const attrs = (result.inputs as typeof material.inputs & {
      attrs: { date: Date; map: Map<string, string>; nil: { value: string }; list: Array<string> }
    }).attrs
    expect(attrs.date).toBe(date)
    expect(attrs.map).toBe(map)
    expect(attrs.nil.value).toBe("resolved")
    expect(attrs.list).toEqual(["resolved"])
    expect((result.inputs as { dependencies: Array<{ key: string }> }).dependencies.map((x) => x.key)).toEqual([
      "resolved",
      "stable"
    ])
  })
  it("collects data descriptors without invoking accessors or traversing class instances", () => {
    let reads = 0
    const getter = Object.defineProperty({}, "secret", {
      get() {
        reads++
        throw new Error("not data")
      }
    })
    const proxy = new Proxy({}, { ownKeys: () => ["absent"], getOwnPropertyDescriptor: () => undefined })
    const marked = { _tag: "Wanted", value: 1 }, nil = Object.assign(Object.create(null), { nested: marked })
    const into: Array<Record<string, unknown>> = []
    collectTagged([getter, proxy, new Date(0), nil, marked], "Wanted", into, new Set())
    expect(into).toEqual([marked])
    expect(reads).toBe(0)
    expect(attrMember(null, "x")).toBeUndefined()
    expect(attrMember(1, "x")).toBeUndefined()
    expect(attrMember(getter, "secret")).toBeUndefined()
    expect(reads).toBe(0)
  })
})

describe("public planner refusal boundaries", () => {
  it("refuses empty patterns and unmatched automatic roots", async () => {
    const { options } = await fixture(
      "export const Package = S.Package({targets:{command:S.Shell.Test({shell:\"true\"})}})"
    )
    await expect(PackageExec.plan({ ...options, patterns: [] })).rejects.toThrow("no target pattern given")
    await expect(PackageExec.plan({ ...options, patterns: ["//:absent"] })).rejects.toThrow(/no targets|not found/)
  })
  it.each(
    [
      ["Npm.Pack", "{manifest:S.file(\"//bad.json\")}", "could not read package manifest"],
      ["Npm.Pack", "{manifest:S.file(\"//empty.json\")}", "must declare non-empty name and version"],
      ["Npm.Published", "{manifest:S.file(\"//bad.json\")}", "could not read package manifest"],
      ["Npm.Published", "{manifest:S.file(\"//empty.json\")}", "must declare a non-empty name"],
      ["Npm.Published", "{manifest:S.file(\"//package.json\")}", ""],
      [
        "Shell.Run",
        "{shell:\"true\",sandbox:\"none\",services:[S.Shell.Test({shell:\"true\"})]}",
        "services entries must be service targets"
      ],
      ["Shell.Run", "{bin:S.Host.bin(\"sh\"),args:[\"{smthrs:flag:missing}\"]}", "names no declared workspace flag"],
      ["Generate", "{script:S.file(\"//absent.ts\"),changes:[]}", "generator script not found"],
      ["Test", "{expect:{_tag:\"FilesDigest\"},toBe:\"empty\"}", "must compare to a declared file"],
      ["Test", "{expect:{_tag:\"FilesDifference\",left:7,right:8},toBe:S.file(\"//empty.json\")}", "can only compare"]
    ] as const
  )("plans %s payload %s without dispatch", async (rule, attrs, refusal) => {
    const { options } = await fixture(declared(rule, attrs), { "bad.json": "{", "empty.json": "{}" })
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    if (refusal) expect(node.refusal).toContain(refusal)
    else expect(node).toBeDefined()
    if (rule === "Npm.Published" && !refusal) {
      expect(node.lane?.kind).toBe("published")
      expect(node.argv).toContain("pacote@21.0.0")
    }
  })
})

describe("manifest-selected binary names", () => {
  it.each([null, {}, { other: "bin.js" }, { first: "a", second: "b" }, { tool: "a", second: "b" }] as const)(
    "resolves or refuses manifest bin %j",
    async (bin) => {
      const files: Record<string, string> = {
        "node_modules/tool/package.json": JSON.stringify({ name: "tool", version: "1.0.0", bin })
      }
      const { root, options } = await fixture(
        "export const Package = S.Package({targets:{command:S.Shell.Test({bin:S.NodeModule.Bin(\"tool\")})}})",
        files
      )
      await write(root, "node_modules/.bin/tool", "#!/bin/sh\necho 1.0.0\n")
      await write(root, "node_modules/.bin/other", "#!/bin/sh\necho 1.0.0\n")
      await Fs.chmod(Path.join(root, "node_modules/.bin/tool"), 0o755)
      await Fs.chmod(Path.join(root, "node_modules/.bin/other"), 0o755)
      const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
      if (bin !== null && Object.keys(bin).length > 1 && !("tool" in bin)) {
        expect(node.refusal).toContain(
          "exposes 2 binaries"
        )
      } else expect(node.refusal, JSON.stringify(node)).toBeUndefined()
    }
  )
})

describe("declared tool refusal boundaries", () => {
  it.each(
    [
      ["S.PackageManager.bin", "declares no Node package manager"],
      ["S.Runtime.bin", "declares no JavaScript runtime"],
      ["S.Runtime.npx(\"some-tool@1.0.0\")", "declares no JavaScript runtime"],
      ["S.Go.bin", "go"],
      ["S.Go.run(\"example.invalid/tool@v1\")", "go"]
    ] as const
  )("refuses unavailable %s before dispatch", async (bin, message) => {
    const { options } = await fixture(
      `export const Package = S.Package({ targets: {command: S.Shell.Test({bin:${bin}})} })`,
      {},
      "",
      false
    )
    const plan = await PackageExec.plan(
      bin.startsWith("S.Go") ? { ...options, environment: { PATH: "/definitely-absent-planner-path" } } : options
    )
    expect(plan.nodes.get("//:command")?.refusal).toContain(message)
  })

  it("refuses an unknown tool reference in argv", async () => {
    const { options } = await fixture(
      declared("Shell.Test", "{bin:S.Host.bin(\"sh\"),args:[\"{smthrs:tool:{\\\"_tag\\\":\\\"UnknownTool\\\"}}\"]}")
    )
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.refusal).toContain("unknown tool reference")
  })

  it("refuses a runtime one-shot in a positional path slot", async () => {
    const { options } = await fixture(
      declared(
        "Shell.Test",
        `{bin:S.Host.bin("sh"),args:[${
          JSON.stringify("{smthrs:tool:{\"_tag\":\"RuntimeNpx\",\"spec\":\"tool@1.0.0\"}}")
        }]}`
      )
    )
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.refusal).toContain("must be used as bin")
  })
})

describe("shared import closure planning", () => {
  it.each([false, true])("shares memoized closures and its cache lifecycle (unavailable=%s)", async (unavailable) => {
    const { root, options } = await fixture(
      `
const one=S.ImportClosure({entries:[S.file("//one.ts")]})
const two=S.ImportClosure({entries:[S.file("//two.ts")]})
const first=S.Shell.Test({shell:"true",data:[one]})
const second=S.Shell.Test({shell:"true",data:[one,two]})
const command=S.Suite({tests:[first,second]})
export const Package=S.Package({targets:{one,two,first,second,command}})`,
      { "one.ts": "export const one=1\n", "two.ts": "export const two=2\n" }
    )
    if (unavailable) {
      await Fs.mkdir(Path.join(root, ".flows"))
      await Fs.writeFile(Path.join(root, ".flows/cache"), "unavailable")
    }
    const notes: Array<string> = []
    const plan = await PackageExec.plan({ ...options, log: (line) => notes.push(line) })
    expect(plan.nodes.get("//:first")?.refusal).toBeUndefined()
    expect(plan.nodes.get("//:second")?.refusal).toBeUndefined()
    expect(plan.closures?.size).toBe(2)
    expect(notes.filter((line) => line.includes("plan-time cache unavailable"))).toHaveLength(unavailable ? 1 : 0)
  })
})

describe("runtime identity requirements", () => {
  it.each(
    [
      ["S.Runtime.Node({version:\">=26.4.0\",executable:\"missing-runtime-executable\"})", "is not present on PATH"],
      ["S.Runtime.Node({version:\">=26.4.0\",executable:\"./tools/missing\"})", "cannot measure"],
      ["S.Runtime.Node({version:\">=26.4.0\",executable:\"/bin/sh\"})", "cannot measure"],
      ["S.Runtime.Node({version:\">=999999\",executable:\"node\"})", "workspace declares node"],
      [
        "S.Runtime.Node({version:\"unsupported\",executable:\"node\"})",
        "supported exact version"
      ]
    ] as const
  )("refuses %s without a measured compatible runtime", async (runtime, message) => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Runtime.bin})}})",
      {},
      "",
      true,
      runtime
    )
    if (runtime.includes("unsupported")) await expect(PackageExec.plan(options)).rejects.toThrow(message)
    else {
      const plan = await PackageExec.plan(options)
      expect(plan.nodes.get("//:command")?.refusal).toContain(message)
    }
  })

  it.each([false, true])("requires a JavaScript npx launcher (batch=%s)", async (batch) => {
    const runtime = `S.Runtime.Node({version:">=26.4.0",executable:${JSON.stringify(process.execPath)}})`
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Runtime.npx(\"tool@1\")})}})",
      {},
      "",
      true,
      runtime
    )
    const bin = Path.join(root, "bin")
    await Fs.mkdir(bin)
    if (batch) {
      await write(root, "bin/tool.cmd", "@echo off\n")
      await Fs.chmod(Path.join(bin, "tool.cmd"), 0o755)
      await Fs.symlink("tool.cmd", Path.join(bin, "npx"))
    }
    const plan = await PackageExec.plan({ ...options, environment: { ...process.env, PATH: bin } })
    expect(plan.nodes.get("//:command")?.refusal).toContain(batch ? "not a batch shim" : "npx is not present")
  })
})

describe("dependency admission", () => {
  it.each([{ verbs: [] }, { verbs: ["build"] }])(
    "refuses dependency verb gate $verbs before scheduling",
    async ({ verbs }) => {
      const { options } = await fixture(`import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
const dep=Target.make("GatedDependency",{attrs:Schema.Struct({}),kinds:["build"],verbGate:${
        JSON.stringify(verbs)
      },implementation:()=>Target.notImplemented("dep")})({})
const command=Target.make("TestDependency",{attrs:Schema.Unknown,kinds:["test"],implementation:()=>Target.notImplemented("test")})({dep})
export const Package=S.Package({targets:{dep,command}})`)
      await expect(PackageExec.plan({ ...options, verb: "test" })).rejects.toThrow(
        `gated to ${verbs.length === 0 ? "no verbs" : "build"}`
      )
    }
  )
  it.each(["cycle", "absent"])("refuses a %s subtree dependency", async (kind) => {
    const { options } = await fixture(
      declared(
        "SelectedDependency",
        `{dependency: S.Target.subtree("//...",${JSON.stringify(kind === "cycle" ? "command" : "absent")})}`
      )
    )
    await expect(PackageExec.plan(options)).rejects.toThrow(
      kind === "cycle" ? "dependency cycle" : "matched no targets"
    )
  })
})

describe("documentation input planning", () => {
  it.each([false, true])("keys a shared nested filegroup once (wrong member=%s)", async (wrong) => {
    const group = wrong ? "S.Shell.Test({shell:\"true\"})" : "S.Filegroup({srcs:[leaf]})"
    const { options } = await fixture(
      `
const leaf=S.Filegroup({srcs:[S.file("//a.ts"),S.file("//z.ts")]})
const nested=${group}
const command=S.Docs.Check({stamp:S.file("//stamp.json"),output:S.file("//page.mdx"),producer:"test",inputs:[leaf,nested,S.file("//other.ts")]})
export const Package=S.Package({targets:{leaf,nested,command}})`,
      { "a.ts": "a", "z.ts": "z", "other.ts": "other", "page.mdx": "page" }
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    if (wrong) expect(node.refusal).toContain("inputs must be files, globs, or Filegroup targets")
    else {
      expect(node.refusal).toBeUndefined()
      expect(node.lane).toMatchObject({
        kind: "docs-check",
        files: [{ path: "a.ts" }, { path: "other.ts" }, { path: "z.ts" }]
      })
    }
  })
})

describe("workspace manifest inputs", () => {
  it("expands pnpm members into its declared content identity", async () => {
    const { options } = await fixture(
      declared("WorkspaceManifests", "{workspace:S.pnpmWorkspace(\"//pnpm-workspace.yaml\")}"),
      {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/a/package.json": "{\"name\":\"a\",\"version\":\"1.0.0\"}",
        "packages/b/package.json": "{\"name\":\"b\",\"version\":\"1.0.0\"}"
      }
    )
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.declaredInputs.flatMap((input) => input.files.map((file) => file.path)))
      .toEqual(expect.arrayContaining(["packages/a/package.json", "packages/b/package.json"]))
  })
})

describe("workspace tool availability", () => {
  it.each(["Npm.Pack", "Npm.Published", "Changesets.Version", "Size.Budgets", "Markdown.CodeBlocks"])(
    "refuses %s without a package manager",
    async (rule) => {
      const { options } = await fixture(declared(rule, "{}"), {}, "", false)
      const plan = await PackageExec.plan(options)
      expect(plan.nodes.get("//:command")?.refusal).toContain("needs the workspace Node package manager")
    }
  )
  it.each(["absent layer", "absent cargo", "standalone cargo"])("resolves a Cargo reference with %s", async (kind) => {
    const extra = kind === "absent layer"
      ? ""
      : `toolchains:[S.Rust.Toolchain({cargo:${
        JSON.stringify(kind === "absent cargo" ? "missing-cargo-executable" : "cargo")
      },rustup:"missing-rustup-executable",channel:"stable"})],`
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:{_tag:\"CargoBin\"}})}})",
      {},
      extra
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    if (kind === "absent layer") expect(node.refusal).toContain("no Rust toolchain layer")
    else if (kind === "absent cargo") expect(node.refusal).toContain("not present on PATH")
    else {
      expect(node.refusal).toBeUndefined()
      expect(node.argv?.[0]).toMatch(/cargo$/)
    }
  })
})

describe("formatter arguments and workspace flags", () => {
  it.each([false, true])(
    "appends confined write roots when only flags are declared (workspace flag=%s)",
    async (flag) => {
      const args = flag ? "[\"--write\",S.Flags.mode]" : "[\"--write\"]"
      const { options } = await fixture(
        `export const Package=S.Package({targets:{command:S.Shell.Diff({bin:S.Host.bin("sh"),args:${args},changes:["**","out/**","out/file.txt"],sandbox:"none"})}})`,
        {},
        "flags:S.Flags({mode:\"--mode=test\"}),"
      )
      const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
      expect(node.refusal).toBeUndefined()
      expect(node.argv?.slice(-3)).toEqual([".", "out", "out/file.txt"])
      if (flag) expect(node.argv).toContain("--mode=test")
    }
  )
})

describe("nested service prerequisites", () => {
  it("hoists a shared service once without scheduling its body as a task", async () => {
    const { options } = await fixture(`
const base=S.Shell.Serve({shell:"sleep 60",sandbox:"none"})
const one=S.Shell.Serve({shell:"sleep 60",services:[base],sandbox:"none"})
const two=S.Shell.Serve({shell:"sleep 60",services:[base],sandbox:"none"})
const command=S.Shell.Test({shell:"true",services:[one,two,base],sandbox:"none"})
export const Package=S.Package({targets:{base,one,two,command}})`)
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.serviceDeps).toEqual(["//:base", "//:one", "//:two"])
    expect(plan.workList.map((row) => row.label)).toEqual(["//:command"])
  })
  it("refuses a consumer of an unavailable service executable before acquisition", async () => {
    const { options } = await fixture(`
const service=S.Shell.Serve({bin:S.Host.bin("missing-service-executable"),sandbox:"none"})
const command=S.Shell.Test({shell:"true",services:[service],sandbox:"none"})
export const Package=S.Package({targets:{service,command}})`)
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.refusal).toContain("service //:service:")
    expect(plan.nodes.get("//:command")?.refusal).toContain("missing-service-executable")
  })
})

describe("tool-output cardinality", () => {
  it.each([{ bins: [] }, { bins: ["one", "two"] }])(
    "refuses a Cargo tool that declares $bins binaries",
    async ({ bins }) => {
      const { options } = await fixture(
        `const producer=S.Cargo.Build({package:"sample",bins:${JSON.stringify(bins)},outDirs:["//target"]})
const command=S.Shell.Test({bin:producer})
export const Package=S.Package({targets:{producer,command}})`,
        {
          "Cargo.toml": "[package]\nname=\"sample\"\nversion=\"1.0.0\"\nedition=\"2021\"\n",
          "src/lib.rs": "pub fn value()->u8{1}\n"
        },
        "toolchains:[S.Rust.Toolchain({workspace:S.file(\"//Cargo.toml\"),channel:\"stable\"})],"
      )
      const plan = await PackageExec.plan(options)
      expect(plan.nodes.get("//:command")?.refusal).toContain("a tool edge needs exactly one")
    }
  )
  it("refuses a target tool with no executable output", async () => {
    const { options } = await fixture(
      `const producer=S.Filegroup({srcs:[S.file("//input.txt")]})
const command=S.Shell.Test({bin:producer})
export const Package=S.Package({targets:{producer,command}})`,
      { "input.txt": "content" }
    )
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.refusal).toContain("declares no executable output")
  })
})

const snapshot = (root: string, first: boolean) => {
  if (first) execFileSync("jj", ["git", "init", "--colocate", root], { stdio: "ignore" })
  execFileSync("jj", ["describe", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  execFileSync("jj", ["new", "-m", ""], { cwd: root, stdio: "ignore" })
}

describe("Git diff admission", () => {
  it.each([
    { filters: "", paths: ["added.ts", "copied.ts", "moved.txt", "other.txt", "tracked.ts"] },
    { filters: ",paths:[\"added*.ts\"]", paths: ["added.ts"] },
    { filters: ",added:[\"added*.ts\"],addedLines:\"documented additions\"", paths: ["added.ts"] }
  ])("keys the selected post-images with $filters", async ({ filters, paths }) => {
    const { root, options } = await fixture(declared("DiffInputs", `{diff:S.gitDiff({base:"HEAD~1"${filters}})}`), {
      ".gitignore": ".flows\n",
      "tracked.ts": "tracked content\n".repeat(100),
      "old.txt": "renamed content\n".repeat(100)
    })
    snapshot(root, true)
    await Fs.appendFile(Path.join(root, ".git/config"), "\n[diff]\n\trenames = copies\n")
    await Fs.rename(Path.join(root, "old.txt"), Path.join(root, "moved.txt"))
    await Fs.copyFile(Path.join(root, "tracked.ts"), Path.join(root, "copied.ts"))
    await Fs.appendFile(Path.join(root, "tracked.ts"), "modified\n")
    await write(root, "added.ts", "added")
    await write(root, "other.txt", "other")
    snapshot(root, false)
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    const diff = node.declaredInputs.find((input) => input.declaration._tag === "GitDiff")!
    expect(diff.files.map((file) => file.path)).toEqual(paths)
    expect(diff.files.every((file) => file.digest !== undefined)).toBe(true)
  })
})

describe("measured tool reuse", () => {
  it("shares a real interpreter probe across runtime and host references", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Runtime.bin,tools:[S.Host.bin(\"node\")]})}})"
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv?.[0]).toMatch(/node$/)
  })
  it("expands a real Go one-shot reference without executing its package", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Go.run(\"example.invalid/probe@v1\")})}})"
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv?.slice(-2)).toEqual(["run", "example.invalid/probe@v1"])
  })
})

const goLayer =
  "toolchains:[S.Go.Toolchain({mod:S.file(\"//go.mod\"),sum:S.file(\"//go.sum\"),versions:S.Nix.DevShell({flake:S.file(\"//go.mod\"),lock:S.file(\"//go.sum\")}),cgo:false})],"
const goFiles = {
  "go.mod": "module example.invalid/planner\n\ngo 1.26.0\n",
  "go.sum": "",
  "main.go": "package main\nfunc main(){}\n"
}
describe("Go generator tool authority", () => {
  it.each(["host", "missing", "one-shot"])("plans generator tool %s without executing directives", async (kind) => {
    const tool = kind === "host"
      ? "S.Host.bin(\"sh\")"
      : kind === "missing"
      ? "S.Host.bin(\"missing-generator\")"
      : "S.Runtime.npx(\"generator@1\")"
    const { options } = await fixture(
      declared("Go.Generate", `{pkgs:["./..."],changes:["generated.go"],tools:[${tool}]}`),
      goFiles,
      goLayer
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    if (kind === "host") {
      expect(node.refusal).toBeUndefined()
      expect(node.env.PATH).toBeDefined()
    } else expect(node.refusal).toContain(kind === "missing" ? "missing-generator" : "not as PATH tools")
  })
  it("refuses a missing Go executable by name", async () => {
    const { options } = await fixture(declared("Go.Test", "{pkgs:[\"./...\"]}"), goFiles, goLayer)
    const plan = await PackageExec.plan({ ...options, environment: { PATH: "/definitely-absent-planner-path" } })
    expect(plan.nodes.get("//:command")?.refusal).toContain("go")
  })
})

describe("crate selector admission", () => {
  it.each(["workspace", "wrong target", "invalid value", "wrong left", "wrong right", "target files"])(
    "reduces %s before cargo execution",
    async (kind) => {
      const crates = kind === "workspace"
        ? "workspace:true,"
        : `crates:${
          kind === "wrong target"
            ? "wrong"
            : kind === "invalid value"
            ? "7"
            : kind === "wrong left"
            ? "S.Files.difference(wrong,all)"
            : kind === "wrong right"
            ? "S.Files.difference(all,wrong)"
            : "{_tag:\"TargetFiles\",target:all}"
        },`
      const source = `import * as Target from "@smthrs/targets/Target"
import * as Schema from "effect/Schema"
const all=S.Cargo.AppSet({manifests:S.glob(["//crates/*/Cargo.toml"])})
const wrong=S.Filegroup({srcs:[]})
const command=Target.make("Cargo.Test",{attrs:Schema.Unknown,kinds:["test"],implementation:()=>Target.notImplemented("Cargo.Test")})({${crates}})
export const Package=S.Package({targets:{all,wrong,command}})`
      const { options } = await fixture(source, {
        "Cargo.toml": "[workspace]\nmembers=[\"crates/a\"]\nresolver=\"2\"\n",
        "crates/a/Cargo.toml": "[package]\nname=\"a\"\nversion=\"1.0.0\"\nedition=\"2021\"\n",
        "crates/a/src/lib.rs": "pub fn value()->u8{1}\n"
      }, "toolchains:[S.Rust.Toolchain({workspace:S.file(\"//Cargo.toml\"),channel:\"stable\"})],")
      const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
      if (kind === "workspace" || kind === "target files") expect(node.refusal).toBeUndefined()
      else expect(node.refusal).toContain("crates must")
    }
  )
})

describe("programmatic source provenance", () => {
  it("reports missing inputs without inventing a source module", async () => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({shell:\"true\"})}})"
    )
    const make = Target.make("ProgrammaticMissing", {
      attrs: Schema.Struct({ files: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("ProgrammaticMissing")
    })
    const subject = make({ files: S.glob("absent/**/*.ts") })
    const command = S.TargetIndex({ summary: "Validate inputs" })
    const index = PackageIndex.make({
      root,
      workspace: options.index.workspace,
      factory: undefined,
      packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { subject, command } }) }]
    }, root)
    expect(Target.metadata(subject).sourceFile).toBeUndefined()
    await expect(PackageExec.plan({ ...options, index })).rejects.toMatchObject({
      _tag: expect.stringContaining("DeclaredInputMissing")
    })
  })
  it("reports sorted crossings for source-less declarations and distinct packages", async () => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({shell:\"true\"})}})",
      {
        "child/a.ts": "a",
        "child/z.ts": "z",
        "child/PACKAGE.ts":
          "import { Smithers as S } from \"@smthrs/targets\";export const Package=S.Package({targets:{}})"
      }
    )
    const make = Target.make("ProgrammaticCrossing", {
      attrs: Schema.Struct({ files: Schema.Unknown }),
      kinds: ["build"],
      implementation: () => Target.notImplemented("ProgrammaticCrossing")
    })
    const first = make({ files: [S.glob("child/a*.ts"), S.glob("child/z*.ts")] }),
      second = make({ files: S.glob("child/*.ts") }),
      child = make({ files: S.file("a.ts") })
    const command = S.TargetIndex({ summary: "Validate crossings" })
    const index = PackageIndex.make({
      root,
      workspace: options.index.workspace,
      factory: undefined,
      packages: [
        { file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { first, second, command } }) },
        { file: "child/PACKAGE.ts", packagePath: "child", value: S.Package({ targets: { child } }) }
      ]
    }, root)
    await expect(PackageExec.plan({ ...options, index })).rejects.toMatchObject({
      _tag: expect.stringContaining("DeclaredInputCrossesPackage")
    })
  })
})

describe("typed lane refusals", () => {
  it.each([
    ["ImportClosure", "{entries:S.Shell.Test({shell:'true'})}", "cannot provide entry files"],
    [
      "Test",
      "{expect:{_tag:'FilesDifference',left:S.Shell.Test({shell:'true'}),right:S.Filegroup({srcs:[]})},toBe:'empty'}",
      "Test:"
    ],
    [
      "Test",
      "{expect:{_tag:'FilesDifference',left:S.Filegroup({srcs:[]}),right:S.Shell.Test({shell:'true'})},toBe:'empty'}",
      "Test:"
    ],
    [
      "Bundler.Rspack.build",
      "{graph:S.Filegroup({srcs:[]}),config:S.file('//bundler.ts'),outDirs:['out'],environment:'test',mode:'production'}",
      "graph of a bundler build"
    ],
    ["Generate", "{bin:S.Filegroup({srcs:[]}),changes:[]}", "declares no executable output"],
    [
      "Shell.Test",
      "{bin:S.Host.bin('sh'),args:['{smthrs:tool:{\"_tag\":\"RuntimeNpx\",\"spec\":\"example@1\"}}']}",
      "not as a path argument"
    ],
    ["Shell.Test", "{bun:'console.log(tool)',using:{tool:S.Host.bin('missing-generator')}}", "missing-generator"],
    ["Foundry.Build", "{}", "forge"],
    ["Docker.Build", "{dockerfile:S.file('//Dockerfile'),context:'.'}", "docker"],
    ["Docker.Serve", "{image:'scratch'}", "docker"]
  ])("retains the %s refusal for %s", async (rule, attrs, expected) => {
    const { options } = await fixture(declared(rule!, attrs!), {
      "bundler.ts": "export default {}",
      "Dockerfile": "FROM scratch"
    })
    const absent = rule!.startsWith("Foundry.") || rule!.startsWith("Docker.")
    const plan = await PackageExec.plan({
      ...options,
      ...(absent ? { environment: { PATH: "/definitely-absent-tools" } } : {})
    })
    expect(plan.nodes.get("//:command")?.refusal).toContain(expected)
  })
})

describe("generator and installation identities", () => {
  it("retains the declared script environment and installation-only module identity", async () => {
    const { options } = await fixture(
      declared("Generate", "{script:S.file('//gen.mjs'),env:{MODE:'public'},changes:[],data:[S.NodeModule('tool')] }"),
      {
        "gen.mjs": "process.stdout.write(process.env.MODE)",
        "node_modules/tool/package.json": JSON.stringify({ name: "tool", version: "1.2.3" })
      }
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.env.MODE).toBe("public")
    expect((node.keyMaterial.inputs as { toolchain: unknown[] }).toolchain).toContainEqual({
      tag: "NodeModule",
      package: "tool",
      version: "1.2.3"
    })
  })
  it("keys a module whose manifest has no version and refuses an absent installed binary", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.NodeModule.Bin('tool')})}})",
      { "node_modules/tool/package.json": "{\"name\":\"tool\",\"bin\":\"index.js\"}" }
    )
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.refusal).toContain("node_modules binary not found")
  })
  it("binds the Go generator environment without running its one-shot package", async () => {
    const { options } = await fixture(
      declared("Generate", "{bin:S.Go.run('example.invalid/tool@v1'),env:{MODE:'public'},changes:[]}"),
      goFiles,
      goLayer
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.env.MODE).toBe("public")
    expect(node.argv?.slice(-2)).toEqual(["run", "example.invalid/tool@v1"])
  })
  it("retains a non-executable installation refusal", async () => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.NodeModule.Bin('tool')})}})",
      {
        "node_modules/tool/package.json": "{\"name\":\"tool\",\"bin\":\"index.js\"}",
        "node_modules/.bin/tool": "#!/bin/sh\necho 1.0.0\n"
      }
    )
    await Fs.chmod(Path.join(root, "node_modules/.bin/tool"), 0o644)
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.refusal).toContain("node_modules binary not found")
  })
})

describe("planning declarations and approval values", () => {
  it.each([false, true])("pins approval stamps in environment (repository=%s)", async (repository) => {
    const { root, options } = await fixture(
      `export const Package=S.Package({targets:{command:S.Shell.Run({shell:'true',env:{REV:${
        JSON.stringify(StampExec.token("commit", Stamp.commit))
      }},approval:'required',sandbox:'none'})}})`
    )
    if (repository) snapshot(root, true)
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    if (repository) {
      expect(node.env.REV).toMatch(/^[0-9a-f]{40}$/)
      expect(node.refusal).not.toContain("stamps could not be resolved")
    } else expect(node.refusal).toContain("stamps could not be resolved")
  })
  it("keeps service argv aligned with pnpm's dependency verification setting", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Serve({bin:S.PackageManager.bin,args:['exec','node','--version'],sandbox:'none'})}})"
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv).toContain("--config.verifyDepsBeforeRun=false")
    expect(node.lane).toMatchObject({ kind: "serve" })
  })
  it("keeps child repositories out of inputs, write-set identities and glob validation", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Generate({command:'true',data:[S.glob('//*.ts')],changes:['**/*.txt']})}})",
      { "public.txt": "public", "child/private.txt": "private" },
      "repos:{child:S.LocalRepository('child')},"
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(JSON.stringify(node.keyMaterial)).not.toContain("private.txt")
  })
  it("refuses an automatic plan that omits every attended root", async () => {
    const { options } = await fixture(
      declared("Docs.Page", "{}")
    )
    await expect(PackageExec.plan({ ...options, unattended: true })).rejects.toThrow("no targets selected")
  })
  it("writes a requested debug key receipt", async () => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Filegroup({srcs:[]})}})"
    )
    const path = Path.join(root, "keys.jsonl"), previous = process.env.SMTHRS_DEBUG_KEYS
    process.env.SMTHRS_DEBUG_KEYS = path
    try {
      await PackageExec.plan(options)
    } finally {
      if (previous === undefined) delete process.env.SMTHRS_DEBUG_KEYS
      else process.env.SMTHRS_DEBUG_KEYS = previous
    }
    expect(await Fs.readFile(path, "utf8")).toContain("//:command")
  })
})

describe("host selection", () => {
  it("uses the selected Windows shell and case-insensitive lookup names", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({shell:'true',sandbox:'none'})}})"
    )
    const plan = await PackageExec.plan({
      ...options,
      platform: "win32",
      environment: { ...process.env, unused: "omitted" }
    })
    expect(plan.nodes.get("//:command")?.refusal).toBeUndefined()
    expect(plan.nodes.get("//:command")?.argv?.[0]).toMatch(/sh$/)
  })
  it("refuses a Bun template when the selected environment lacks Bun", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bun:'console.log(1)'})}})"
    )
    const plan = await PackageExec.plan({ ...options, environment: { PATH: "/definitely-absent-bun" } })
    expect(plan.nodes.get("//:command")?.refusal).toContain("bun is required")
  })
})

describe("diff protocol rows", () => {
  it.each(["R100\0before\0", "C100\0before\0\0", "M\0", "M\0\0"])("ignores incomplete row %j", (row) => {
    expect(parseNameStatusZ(row)).toEqual([])
  })
})

describe("bundler cache planning", () => {
  it.each(["valid", "invalid", "unavailable"])("shares a graph lookup across two consumers (%s)", async (kind) => {
    const { root, options } = await fixture(
      `const rspack=S.Bundler.Rspack({config:S.file('//bundler.mjs')})
const graph=rspack.resolve({entries:["main.ts"],universe:[]})
const one=rspack.build({environment:'web',mode:'development',graph,outDirs:['one'],env:{MODE:'one'}})
const two=rspack.build({environment:'web',mode:'development',graph,outDirs:['two']})
const command=S.Suite({tests:[one,two]})
export const Package=S.Package({targets:{graph,one,two,command}})`,
      { "bundler.mjs": "export default {}" }
    )
    const first = await PackageExec.plan(options), key = first.nodes.get("//:graph")!.keyPreview
    if (kind === "unavailable") {
      await Fs.rm(Path.join(root, ".flows"), { recursive: true, force: true })
      await write(root, ".flows", "blocked cache directory")
    } else {
      const cache = await Cache.openCache({ workspaceRoot: root, cacheDirectory: ".flows" })
      const result = {
        files: [],
        packages: [],
        moduleCount: 0,
        graphDigest: BundlerTarget.graphDigest({ files: [], packages: [] })
      }
      await cache.put(key, {
        key,
        target: "Bundler.Rspack.resolve",
        label: "//:graph",
        exitOk: true,
        output: { kind: "bundler-resolve", result: kind === "valid" ? result : {} },
        storedAt: new Date(0).toISOString()
      })
      await cache.close()
    }
    const next = await PackageExec.plan(options)
    for (const name of ["one", "two"]) {
      const node = next.nodes.get("//:" + name)!
      expect(node.refusal).toBeUndefined()
      if (kind === "valid") expect(node.keyPreview).not.toBe(first.nodes.get("//:" + name)!.keyPreview)
      else expect(node.keyPreview).toBe(first.nodes.get("//:" + name)!.keyPreview)
    }
  })
})

describe("recursive cleanup and malformed optional attributes", () => {
  it("collects nested cleanup outputs and preserves explicit paths", async () => {
    const { options } = await fixture(`const leaf=S.Shell.Build({shell:'true',outDirs:['leaf'],sandbox:'none'})
const inner=S.Shell.Build({shell:'true',data:[leaf],outDirs:['inner'],sandbox:'none'})
const command=S.Clean({targets:[inner],paths:['manual']})
export const Package=S.Package({targets:{command}})`)
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.cleanOutDirs).toContain("leaf")
    expect(node.cleanPaths).toContain("manual")
    expect(plan.workList.map((x) => x.label)).toEqual(["//:command"])
  })
  it.each([
    ["Alias", "{}"],
    ["Materialize", "{}"],
    ["TsBuild", "{}"],
    ["Generate", "{changes:[7],emit:{'valid.txt':'x','invalid':7},outDirs:[7],outFiles:[7]}"],
    ["Owners.Codeowners", "{}"],
    ["Owners.Tree", "{}"],
    ["Shell.Test", "{shell:'true',timeout:'1s',secrets:[{_tag:'HttpCredential'}],sandbox:'none'}"]
  ])("plans custom %s declarations without inventing optional paths", async (rule, attrs) => {
    const { options } = await fixture(declared(rule!, attrs!))
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect([...node.outDirs, ...node.outFiles, ...node.writeSet].every((x) => typeof x === "string")).toBe(true)
    if (rule === "Alias" || rule === "Materialize") expect(node.dependencies).toEqual([])
    if (rule === "Shell.Test") expect(node.timeoutMs).toBe(1000)
  })
})

describe("SDK and interpreter authority", () => {
  it.each(["absolute", "no command"])("identifies an env shebang with %s", async (kind) => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.NodeModule.Bin('tool')})}})",
      {
        "node_modules/tool/package.json": "{\"name\":\"tool\",\"bin\":\"index.js\",\"version\":\"1.0.0\"}",
        "node_modules/.bin/tool": kind === "absolute" ? "#!/usr/bin/env /bin/sh\necho 1.0.0\n" : "#!/usr/bin/env\n"
      }
    )
    await Fs.chmod(Path.join(root, "node_modules/.bin/tool"), 0o755)
    if (kind === "no command") await expect(PackageExec.plan(options)).rejects.toThrow("cannot identify env shebang")
    else expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toBeUndefined()
  })
  it("deduplicates a real SDK grant shared by distinct Go references", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Go.bin,tools:[S.Go.run('example.invalid/tool@v1')]})}})"
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(new Set(node.externalReads).size).toBe(node.externalReads.length)
  })
  it("keeps a workspace-owned SDK outside external read grants", async () => {
    const sdk = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim()
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Go.bin})}})"
    )
    const owned = Path.join(root, "sdk")
    await Fs.mkdir(owned)
    for (const name of ["bin", "pkg"]) await Fs.symlink(Path.join(sdk, name), Path.join(owned, name), "dir")
    const plan = await PackageExec.plan({ ...options, environment: { ...process.env, GOROOT: owned } }),
      node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.externalReads).not.toContain(owned)
  })
  it("selects absolute cargo and rustup paths using a toolchain file", async () => {
    const cargo = PackageTree.findOnPath("cargo")!, rustup = PackageTree.findOnPath("rustup")!
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:{_tag:'CargoBin'}})}})",
      { "rust-toolchain.toml": "[toolchain]\nchannel=\"stable\"\n" },
      `toolchains:[S.Rust.Toolchain({toolchain:S.file('//rust-toolchain.toml'),cargo:${JSON.stringify(cargo)},rustup:${
        JSON.stringify(rustup)
      }})],`
    )
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.refusal).toBeUndefined()
  })
  it("refuses an invalid Go module graph with its planning cause", async () => {
    const { options } = await fixture(declared("Go.Test", "{pkgs:[\"./...\"]}"), {
      ...goFiles,
      "go.mod": "not a module\n"
    }, goLayer)
    const plan = await PackageExec.plan(options)
    expect(plan.nodes.get("//:command")?.refusal).toContain("Go planning failed:")
  })
  it("retains a target-tool argv suffix after replacing the executable", async () => {
    const { options } = await fixture(
      `const producer=S.Cargo.Build({package:'sample',bins:['sample'],outDirs:['target']})
const command=S.Generate({bin:producer,args:['--version'],changes:['generated.txt']})
export const Package=S.Package({targets:{command}})`
    )
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv?.at(-1)).toBe("--version")
  })
})

describe("plan-time manifest faults", () => {
  it("uses real host services by default and exposes invalid requests as typed failures", async () => {
    const { options } = await fixture("export const Package=S.Package({targets:{command:S.Filegroup({srcs:[]})}})")
    expect((await Effect.runPromise(planEffect(options))).roots).toEqual(["//:command"])
    const failed = await Effect.runPromiseExit(planEffect({ ...options, patterns: [] }))
    expect(Exit.isFailure(failed)).toBe(true)
  })
  it("keeps an unreadable crate out of its selector after input admission", async () => {
    const { options } = await fixture(
      `const all=S.Cargo.AppSet({manifests:S.glob('//crates/*/Cargo.toml')})
const command=S.Cargo.Test({crates:all})
export const Package=S.Package({targets:{command}})`,
      { "crates/a/Cargo.toml": "[package]\nname=\"a\"\nversion=\"1.0.0\"\n" },
      "toolchains:[S.Rust.Toolchain({channel:'stable'})],"
    )
    const reads: string[] = []
    const services = {
      ...planningServicesLive,
      readCrateManifest: (path: string) =>
        Effect.sync(() => reads.push(path)).pipe(Effect.andThen(Effect.fail(new Error("manifest became unreadable"))))
    }
    const plan = await Effect.runPromise(planEffect(options).pipe(Effect.provideService(PlanningServices, services)))
    expect(reads.map((x) => Path.relative(options.index.root, x))).toEqual(["crates/a/Cargo.toml"])
    expect(plan.nodes.get("//:command")?.lane).toMatchObject({ kind: "cargo", commands: [] })
  })
})

describe("opaque repository refusals", () => {
  it.each([false, true])("reports the actual child failure (has commit=%s)", async (committed) => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Repo.Target('child','//:test')}})",
      {},
      "repos:{child:S.LocalRepository('child')},"
    )
    const child = Path.join(root, "child")
    await write(
      root,
      "child/WORKSPACE.ts",
      (await Fs.readFile(Path.join(root, "WORKSPACE.ts"), "utf8")).replace(
        "repos:{child:S.LocalRepository('child')},",
        ""
      )
    )
    await write(root, "child/package.json", await Fs.readFile(Path.join(root, "package.json"), "utf8"))
    await write(root, "child/pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    await write(
      root,
      "child/PACKAGE.ts",
      `import {Smithers as S} from '@smthrs/targets';export const Package=S.Package({targets:{test:S.Shell.Test({shell:'true',data:[S.gitDiff({base:'HEAD~999'})],sandbox:'none'})}})`
    )
    if (committed) snapshot(child, true)
    else await write(root, "child/.git", "gitdir: /definitely-absent-child-git")
    const plan = await PackageExec.plan({ ...options, plan: true })
    expect(plan.nodes.get("//:command")?.refusal).toContain(
      committed ? "plan refused:" : "could not read child repository HEAD:"
    )
  })
})

describe("optional cargo outputs and formats", () => {
  it.each([{ outDirs: undefined }, { outDirs: [] }])(
    "plans a fetch with outDirs=$outDirs and no fabricated home",
    async ({ outDirs }) => {
      const source = `const fetch=S.Cargo.Fetch({workspace:S.file('//Cargo.toml')${
        outDirs === undefined ? "" : ",outDirs:[]"
      }})
const command=S.Shell.Test({shell:'true',data:[fetch],sandbox:'none'})
export const Package=S.Package({targets:{command}})`
      const { options } = await fixture(
        source,
        { "Cargo.toml": "[package]\nname=\"a\"\nversion=\"1.0.0\"\n" },
        "toolchains:[S.Rust.Toolchain({channel:'stable'})],"
      )
      expect((await PackageExec.plan(options)).nodes.get("//:command")?.env.CARGO_HOME).toBeUndefined()
    }
  )
  it("formats the default cargo workspace when no crate selector is present", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Cargo.Fmt({})}})",
      {},
      "toolchains:[S.Rust.Toolchain({channel:'stable'})],"
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.argv).toContain("fmt")
  })
  it("records anonymous crate manifests and scalar glob declarations", async () => {
    const { options } = await fixture(
      declared("Cargo.Test", "{crates:S.Cargo.AppSet({manifests:S.glob('//Cargo.toml')})}"),
      { "Cargo.toml": "[workspace]\nmembers=[]\n" },
      "toolchains:[S.Rust.Toolchain({channel:'stable'})],"
    )
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(JSON.stringify(node.keyMaterial.inputs)).toContain("\"name\":null")
  })
})

describe("mise executable authority", () => {
  it("measures the real mise launcher with its declared pin", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Mise.bin('go')})}})",
      { "mise.toml": "[tools]\ngo=\"1.26.0\"\n" },
      "toolchains:[S.Mise({config:S.file('//mise.toml')})],"
    )
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv?.[0]).toMatch(/mise$/)
  })
})

describe("runtime profiles", () => {
  it("retains the refusal for an unsupported pre-resolved requirement", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Runtime.bin})}})",
      {},
      "",
      true,
      "S.Runtime.ResolvedNodeRuntime.make({name:'node',version:'^26',executable:'node'})"
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toContain(
      "unsupported workspace node version requirement"
    )
  })
  it("refuses a manager whose own selected runtime is unavailable", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.PackageManager.bin})}})",
      {},
      "packageManager:S.PackageManager.Pnpm({version:'11.25.0',runtime:S.Runtime.ResolvedNodeRuntime.make({name:'node',version:'>=99999',executable:'node'})}),"
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toContain(
      "workspace declares node >=99999"
    )
  })
  it("measures a real manager without a lowered legacy version", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.PackageManager.bin})}})",
      { "yarn.lock": "# yarn lockfile v1\n" },
      "packageManager:S.PackageManager.Yarn({manifest:S.file('//package.json'),lockfile:S.file('//yarn.lock')}),"
    )
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv?.[0]).toMatch(/yarn$/)
  })
})

describe("grouped planner data", () => {
  it("collects nested agent data labels in encounter order", async () => {
    const { options } = await fixture(
      `const group=S.Filegroup({srcs:[S.file('//a.ts')]})
const command=S.Agent.Lint({prompt:S.file('//prompt.md'),data:[[group,S.file('//a.ts')]]})
export const Package=S.Package({targets:{group,command}})`,
      { "a.ts": "a", "prompt.md": "Check inputs" }
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.lane).toMatchObject({
      kind: "agent",
      dataLabels: ["//:group"]
    })
  })
  it("walks grouped documentation inputs through nested non-filegroup producers", async () => {
    const { options } = await fixture(
      `import * as Target from '@smthrs/targets/Target'
import * as Schema from 'effect/Schema'
const producer=S.Literal({content:'generated',path:'generated.txt'})
const group=S.Filegroup({srcs:[producer]})
const command=Target.make('Docs.Check',{attrs:Schema.Unknown,kinds:['test'],implementation:()=>Target.notImplemented('Docs.Check')})({inputs:[[group],S.file('//a.ts')],stamp:S.file('//stamp.json'),output:S.file('//page.mdx')})
export const Package=S.Package({targets:{producer,group,command}})`,
      { "a.ts": "a", "page.mdx": "page" }
    )
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.lane).toMatchObject({ kind: "docs-check", files: [{ path: "a.ts" }] })
  })
  it("excludes diff records from a filegroup documentation manifest", async () => {
    const { root, options } = await fixture(
      `import * as Target from '@smthrs/targets/Target'
import * as Schema from 'effect/Schema'
const group=Target.make('Filegroup',{attrs:Schema.Struct({cwd:Schema.String}),kinds:['build'],inputs:()=>[S.gitDiff({base:'HEAD'})],implementation:()=>Target.notImplemented('Filegroup')})({cwd:'.'})
const command=S.Docs.Check({inputs:[group,S.file('//a.ts')],stamp:S.file('//stamp.json'),output:S.file('//page.mdx')})
export const Package=S.Package({targets:{group,command}})`,
      { "a.ts": "a", "page.mdx": "page", ".gitignore": ".flows\n" }
    )
    snapshot(root, true)
    await write(root, "unrelated.ts", "change")
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.lane).toMatchObject({ kind: "docs-check", files: [{ path: "a.ts" }] })
  })
  it("accepts an existing literal glob even when ignored by discovery", async () => {
    const { options } = await fixture(
      `const ignored=S.Filegroup({srcs:[S.glob('//ignored.ts')]})
const command=S.TargetIndex({summary:'Check'})
export const Package=S.Package({targets:{ignored,command}})`,
      { "ignored.ts": "exists", ".gitignore": "ignored.ts\n.flows\n" }
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toBeUndefined()
  })
  it("validates repository boundaries while indexing", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.TargetIndex({summary:'Check'})}})",
      { "child/private.ts": "private" },
      "repos:{child:S.LocalRepository('child')},"
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toBeUndefined()
  })
})

describe("optional command forms", () => {
  it("plans a Windows bash script through its declared host executable", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({script:S.file('//run.bash'),sandbox:'none'})}})",
      { "run.bash": "echo okay" }
    )
    const node = (await PackageExec.plan({ ...options, platform: "win32" })).nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.argv?.[0]).toMatch(/bash$/)
  })
  it("appends a formatter write set with no argument list", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Diff({bin:S.Host.bin('sh'),changes:['out'],sandbox:'none'})}})"
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.argv?.at(-1)).toBe("out")
  })
  it("refuses a service requiring undeclared network access before command selection", async () => {
    const { options } = await fixture(`const nested=S.Shell.Serve({shell:'sleep 1',sandbox:'none'})
const command=S.Shell.Serve({shell:'sleep 1',services:[nested]})
export const Package=S.Package({targets:{command}})`)
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toContain(
      "services require an explicit sandbox network declaration"
    )
  })
  it.each([["Owners.Codeowners", "{path:'//custom/CODEOWNERS',org:'example'}"], [
    "Owners.Tree",
    "{file:'MAINTAINERS'}"
  ]])("renders explicit %s paths", async (rule, attrs) => {
    const { options } = await fixture(declared(rule!, attrs!))
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.emit).toBeDefined()
  })
  it("plans materialization with a real member target", async () => {
    const { options } = await fixture(
      "const inner=S.Filegroup({srcs:[]});export const Package=S.Package({targets:{command:S.Materialize(inner)}})"
    )
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.materializeOf).toBeDefined()
    expect(node.dependencies).toEqual([node.materializeOf])
  })
})

describe("declared metadata boundaries", () => {
  it.each([
    ["Shell.Build", "{shell:'true',outDirs:[7,'out'],outFiles:[7,'out/file.txt'],sandbox:'none'}"],
    ["Cargo.Test", "{workspace:true,outDirs:[7,'target']}"],
    ["Generate", "{}"],
    ["Clean", "{}"]
  ])("keeps only portable output paths for a custom %s declaration", async (rule, attrs) => {
    const { options } = await fixture(declared(rule!, attrs!), {}, "toolchains:[S.Rust.Toolchain({channel:'stable'})],")
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect([...node.outDirs, ...node.outFiles, ...node.writeSet].every((x) => typeof x === "string")).toBe(true)
    if (rule === "Shell.Build") {
      expect(node.outDirs).toEqual(["out"])
      expect(node.outFiles).toEqual(["out/file.txt"])
    }
    if (rule === "Cargo.Test") expect(node.outDirs).toEqual(["target"])
    if (rule === "Clean") expect(node.cleanPaths).toEqual([])
  })
  it("omits an absent page output from write admission", async () => {
    const { options } = await fixture(
      declared(
        "Docs.Page",
        "{brief:S.file('//brief.md'),prompt:S.file('//prompt.md'),references:[],inputs:[],gates:[],maxRounds:1}"
      ),
      { "brief.md": "Brief", "prompt.md": "Prompt" }
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.writeSet).toEqual([])
  })
  it("collects valid clean paths from arbitrary artifact metadata", async () => {
    const { options } = await fixture(
      declared(
        "Clean",
        "{targets:[Target.make('Artifact',{attrs:Schema.Unknown,kinds:['build'],implementation:()=>Target.notImplemented('Artifact')})({outDirs:[7,'valid']})],paths:[7,'manual']}"
      )
    )
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.cleanOutDirs).toEqual(["valid"])
    expect(node.cleanPaths).toEqual(["manual"])
  })
  it("keeps flag references while appending declared write roots", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Diff({bin:S.Host.bin('sh'),args:[{_tag:'FlagRef',name:'mode'}],changes:['out'],sandbox:'none'})}})",
      {},
      "flags:S.Flags({mode:'--mode=formatted'}),"
    )
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.argv?.slice(-2)).toEqual(["--mode=formatted", "out"])
  })
  it("supplies the default index pattern for a custom index declaration", async () => {
    const { options } = await fixture(declared("TargetIndex", "{summary:'Validate'}"))
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toBeUndefined()
  })
  it("keeps reviews for targets outside a selected index intact", async () => {
    const { options } = await fixture(
      `const selected=S.Filegroup({srcs:[]})
const other=S.Filegroup({srcs:[]})
const command=S.TargetIndex({summary:'Validate',pattern:'//:selected'})
export const Package=S.Package({targets:{selected,other,command}})`,
      { ".smithers/cross-package-globs.json": JSON.stringify([{ label: "//:other", path: "old/**/*.ts" }]) }
    )
    expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toBeUndefined()
  })
  it("refuses an Anvil service when the host has no Anvil executable", async () => {
    const { options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Anvil.Fork({forkUrl:S.Secret('RPC'),forkBlockNumber:1,port:8545})}})"
    )
    const previous = process.env.PATH
    process.env.PATH = "/definitely-absent-anvil"
    try {
      expect((await PackageExec.plan(options)).nodes.get("//:command")?.refusal).toContain("anvil")
    } finally {
      if (previous === undefined) delete process.env.PATH
      else process.env.PATH = previous
    }
  })
  it("plans generator tools with an explicit environment when the process has no PATH", async () => {
    const { options } = await fixture(
      declared("Go.Generate", "{pkgs:['./...'],changes:['generated.go'],tools:[S.Host.bin('sh')]}"),
      goFiles,
      goLayer
    )
    const environment = { ...process.env }, previous = process.env.PATH
    delete process.env.PATH
    try {
      const node = (await PackageExec.plan({ ...options, environment })).nodes.get("//:command")!
      expect(node.refusal).toBeUndefined()
      expect(node.env.PATH).toBe(Path.dirname(PackageTree.findOnPath("sh", environment)!))
    } finally {
      if (previous !== undefined) process.env.PATH = previous
    }
  })
})

describe("index ownership boundaries", () => {
  it("plans absolute labels from a caller outside the indexed workspace", async () => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Filegroup({srcs:[]})}})"
    )
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), Os.tmpdir())
    expect(index.currentPackage).toBeUndefined()
    expect((await PackageExec.plan({ ...options, index })).roots).toEqual(["//:command"])
  })
  it("assigns an anonymous kind-only dependency to the root package", async () => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Filegroup({srcs:[]})}})"
    )
    const privateTarget = S.Filegroup({ srcs: [] })
    const command = Target.make("VariantRoot", {
      attrs: Schema.Struct({ dep: Schema.optional(Target.Target) }),
      kinds: ["test"],
      attrsForKind: (_kind, attrs) => ({ ...attrs, dep: privateTarget }),
      implementation: () => Target.notImplemented("VariantRoot")
    })({})
    const index = PackageIndex.make({
      root,
      workspace: options.index.workspace,
      factory: undefined,
      packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { command } }) }]
    }, root)
    expect(Target.metadata(privateTarget).sourceFile).toBeUndefined()
    expect(index.ownerOf(privateTarget)).toBeUndefined()
    const plan = await PackageExec.plan({ ...options, index, verb: "test" })
    expect(plan.nodes.get("//:command")?.dependencies).toHaveLength(1)
    expect(plan.workList).toHaveLength(2)
  })
  it("uses indexed ownership for a reusable target declared outside the workspace", async () => {
    const first = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({shell:'true',sandbox:'none'})}})"
    )
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Filegroup({srcs:[]})}})"
    )
    const command = first.options.index.resolve("//:command")[0]!.target
    const index = PackageIndex.make({
      root,
      workspace: options.index.workspace,
      factory: undefined,
      packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: { command } }) }]
    }, root)
    expect((await PackageExec.plan({ ...options, index })).nodes.get("//:command")?.refusal).toBeUndefined()
  })
})

describe("real Git patch limits", () => {
  it("enforces the aggregate patch ceiling across separate argv batches", async () => {
    const { root, options } = await fixture(declared("DiffInputs", "{diff:S.gitDiff({base:'HEAD~1'})}"), {
      ".gitignore": ".flows\n"
    })
    snapshot(root, true)
    await Fs.mkdir(Path.join(root, "large"))
    const contents = ("x".repeat(1023) + "\n").repeat(512)
    await Promise.all(
      Array.from(
        { length: 520 },
        (_, index) =>
          Fs.writeFile(Path.join(root, "large", "path".repeat(48) + String(index).padStart(4, "0") + ".txt"), contents)
      )
    )
    snapshot(root, false)
    await expect(PackageExec.plan(options)).rejects.toThrow("stdout maxBuffer length exceeded")
  })
})

describe("real Nix environment planning", () => {
  it("binds the actual evaluated environment and runs its selected shell", async () => {
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Host.bin('sh'),args:['-c','test \"$SSL_CERT_FILE\" = /etc/ssl/certs/ca-certificates.crt'],sandbox:'none'})}})",
      {
        "environment.nix": `builtins.derivation {
 outputs=["out"];name="planner-environment";system=builtins.currentSystem;builder="/bin/bash";
 args=["-c" "eval \\\"$buildCommand\\\""];
 buildCommand="/bin/mkdir -p \\\"$out\\\"";
 PATH="/usr/bin:/bin";SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt";
}`
      },
      "environment:S.Nix.Environment({file:S.file('//environment.nix')}),",
      false
    )
    snapshot(root, true)
    const plan = await PackageExec.plan(options), node = plan.nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.nixEnvironment?.path).toEqual(["/usr/bin", "/bin"])
    expect(node.nixEnvironment?.variables.SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt")
    expect((await Fs.stat(node.nixEnvironment!.storePath)).isDirectory()).toBe(true)
    const run = await PackageExec.run(options)
    expect(run.ok).toBe(true)
    expect(run.counts.ran).toBe(1)
  })
})

describe("cleanup value members", () => {
  it("keeps a filegroup with no output directories out of cleanup", async () => {
    const { options } = await fixture(
      "const member=S.Filegroup({srcs:[]});export const Package=S.Package({targets:{command:S.Clean({targets:[member]})}})"
    )
    const node = (await PackageExec.plan(options)).nodes.get("//:command")!
    expect(node.cleanOutDirs).toEqual([])
    expect(node.dependencies).toEqual([])
  })
})

describe("relative SDK configuration", () => {
  it("never admits a relative Go SDK root as external authority", async () => {
    const sdk = execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim()
    const relative = "../".repeat(32) + sdk.slice(1)
    const { root, options } = await fixture(
      "export const Package=S.Package({targets:{command:S.Shell.Test({bin:S.Go.bin})}})"
    )
    const environment = { ...process.env, GOROOT: relative }
    const measured = execFileSync("go", ["env", "GOROOT"], { cwd: root, env: environment, encoding: "utf8" }).trim()
    expect(Path.isAbsolute(measured)).toBe(false)
    const node = (await PackageExec.plan({ ...options, environment })).nodes.get("//:command")!
    expect(node.refusal).toBeUndefined()
    expect(node.externalReads).not.toContain(measured)
    expect(node.externalReads.every((path) => Path.isAbsolute(path))).toBe(true)
  })
})
