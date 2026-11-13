/**
 * Every declared shape the index row states: each input kind, declared
 * outputs resolved from their working directory, a Generate rule's emitted
 * files, a repository target's refusal, a rule whose attrs are not a record,
 * and a declaration evaluated outside the workspace, which states no source.
 *
 * @since 1.0.0
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as TargetIndex from "../src/TargetIndex.ts"

let root: string
let outside: string
let listing: TargetIndex.Listing

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-index-shapes-")))
  outside = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-index-outside-")))
  await Fs.writeFile(
    Path.join(root, "WORKSPACE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
  )
  await Fs.writeFile(
    Path.join(root, "package.json"),
    JSON.stringify({ name: "index-shapes-fixture", private: true, packageManager: "pnpm@11.25.0" })
  )
  await Fs.writeFile(Path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
  await Fs.writeFile(
    Path.join(outside, "PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
export const borrowed = S.Shell.Test({ shell: "true", lifecycle: "artifact", summary: "Captured upstream behavior" })
`
  )
  await Fs.mkdir(Path.join(root, "tools"), { recursive: true })
  await Fs.writeFile(
    Path.join(root, "tools/PACKAGE.ts"),
    `import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import { Schema } from "effect"
import { borrowed } from ${JSON.stringify(Path.join(outside, "PACKAGE.ts"))}
const Opaque = Target.make("Opaque", {
  attrs: Schema.String,
  kinds: ["build"],
  implementation: () => Target.notImplemented("Opaque")
})
const tool = (cwd: string | undefined) => S.ToolBuild({
  tool: "make",
  command: "make",
  args: [],
  inputs: [
    S.pnpmWorkspace("//pnpm-workspace.yaml"),
    S.nodeModules("//"),
    S.nodeModules("web"),
    S.link("current"),
    S.gitDiff({ base: "main", paths: ["src"], added: ["src/new.ts"], addedLines: "TODO" }),
    S.gitDiff()
  ],
  outputs: ["dist", "types"],
  deps: [],
  env: {},
  cache: true,
  ...(cwd === undefined ? {} : { cwd })
})
export const Package = S.Package({ targets: {
  rootTool: tool(undefined),
  nestedTool: tool("tools/native"),
  generated: S.Generate({ emit: { "gen/b.txt": "b", "gen/a.txt": "a" } }),
  remote: S.Repo.Target("elsewhere", "//:test"),
  opaque: Opaque("plain text attrs"),
  borrowed
} })
`
  )
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
  listing = await TargetIndex.build(index, "//...", {})
})

afterAll(async () => {
  for (const directory of [root, outside]) {
    if (directory !== undefined) await Fs.rm(directory, { recursive: true, force: true })
  }
})

const row = (label: string): TargetIndex.Row => {
  const found = listing.targets.find((entry) => entry.label === label)
  if (found === undefined) throw new Error(`no row ${label}`)
  return found
}

describe("declared inputs", () => {
  it("states every input kind with paths resolved from the declaring package", () => {
    expect(row("//tools:rootTool").inputs).toEqual([
      { kind: "pnpm-workspace", path: "pnpm-workspace.yaml" },
      { kind: "node-modules", path: "." },
      { kind: "node-modules", path: "tools/web" },
      { kind: "link", path: "tools/current" },
      { kind: "git-diff", base: "main", paths: ["src"], added: ["src/new.ts"], addedLines: "TODO" },
      { kind: "git-diff", base: "HEAD" }
    ])
  })
})

describe("declared outputs", () => {
  it("resolves a rule's outputs from the workspace root when it runs there", () => {
    expect(row("//tools:rootTool").outputs).toEqual(["dist", "types"])
  })

  it("resolves a rule's outputs from the directory it runs in", () => {
    expect(row("//tools:nestedTool").outputs).toEqual(["tools/native/dist", "tools/native/types"])
  })

  it("lists a Generate rule's emitted files from its package, sorted", () => {
    expect(row("//tools:generated").outputs).toEqual(["tools/gen/a.txt", "tools/gen/b.txt"])
  })
})

describe("rows a declaration cannot fully state", () => {
  it("carries the refusal of a repository target whose repository is not declared", () => {
    const remote = row("//tools:remote")
    expect(remote.rule).toBe("Repo.Target")
    expect(remote.refusal).toContain("not declared in Workspace repos")
    expect(row("//tools:rootTool")).not.toHaveProperty("refusal")
  })

  it("reads no mode, outputs or destinations from attrs that are not a record", () => {
    const opaque = row("//tools:opaque")
    expect(opaque).toMatchObject({ rule: "Opaque", kinds: ["build"], outputs: [] })
    expect(opaque).not.toHaveProperty("mode")
    expect(opaque).not.toHaveProperty("destinations")
    expect(opaque.source).toEqual({ file: "tools/PACKAGE.ts" })
  })

  it("states no source for a declaration evaluated outside the workspace", () => {
    const borrowed = row("//tools:borrowed")
    expect(borrowed.rule).toBe("Shell.Test")
    expect(borrowed).not.toHaveProperty("source")
  })

  it("renders the lifecycle, the refusal and the generated outputs for a person", () => {
    const text = TargetIndex.text({
      pattern: "//...",
      targets: [row("//tools:borrowed"), row("//tools:generated"), row("//tools:remote")]
    })
    expect(text.split("\n").slice(1)).toEqual([
      "//tools:borrowed   Shell.Test   test  lifecycle: artifact",
      "//tools:generated  Generate     run lint  -> tools/gen/a.txt tools/gen/b.txt",
      `//tools:remote     Repo.Target    (refused: ${row("//tools:remote").refusal})`
    ])
  })
})
