import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("runner-value-rules", {
  repository: "git+https://example.invalid/runner-value-rules.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`

const fixture = async (source: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-runner-value-")))
  roots.push(root)
  await write(root, "WORKSPACE.ts", workspace)
  await write(root, "PACKAGE.ts", source)
  await write(root, "package.json", "{\"name\":\"runner-value-rules\",\"private\":true}\n")
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
  NodeChildProcess.execFileSync("git", ["-C", root, "add", "-A"])
  NodeChildProcess.execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=t@t.t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init"
  ])
  return root
}

const run = async (root: string, label: string) =>
  PackageExec.run({
    index: PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)), root),
    cacheDirectory: ".flows",
    verb: "auto",
    patterns: [label]
  })

const statuses = (results: ReadonlyArray<{ readonly label: string; readonly status: string }>) =>
  Object.fromEntries(results.map((entry) => [entry.label, entry.status]))

const exists = (path: string): Promise<boolean> => Fs.stat(path).then(() => true, () => false)

describe("Clean execution", () => {
  it("removes a cleaned target's outDirs and the declared scratch paths, and nothing else", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
const build = S.Shell.Build({ shell: "mkdir -p dist && printf built > dist/a.txt", outDirs: ["dist"] })
export const Package = S.Package({ targets: {
  build,
  clean: S.Clean({ targets: [build], paths: ["scratch", "notes.tmp"] })
} })
`)
    await write(root, "dist/stale.txt", "stale")
    await write(root, "scratch/a/b.txt", "scratch")
    await write(root, "notes.tmp", "notes")
    await write(root, "keep.txt", "keep")
    const cleaned = await run(root, "//:clean")
    expect(cleaned.results).toMatchObject([{ label: "//:clean", status: "ran" }])
    for (const path of ["dist", "scratch", "notes.tmp"]) expect(await exists(NodePath.join(root, path))).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "keep.txt"), "utf8")).toBe("keep")
  })

  it("refuses a scratch path that leaves the workspace and removes nothing outside it", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { clean: S.Clean({ paths: ["../outside"] }) } })
`)
    const outside = NodePath.join(NodePath.dirname(root), "outside")
    const refused = await run(root, "//:clean")
    expect(refused.ok).toBe(false)
    expect(refused.results).toMatchObject([{ label: "//:clean", status: "failed" }])
    expect(refused.results[0]?.error).toContain("clean path refused")
    expect(await exists(outside)).toBe(false)
  })
})

describe("Materialize execution", () => {
  it("places a cacheable build's captured tree and answers green when the tree already matches", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
const build = S.Shell.Build({
  shell: "mkdir -p dist && printf built > dist/a.txt && printf file > out.txt",
  outDirs: ["dist"], outFiles: ["out.txt"]
})
export const Package = S.Package({ targets: { build, materialized: S.Materialize(build) } })
`)
    const first = await run(root, "//:materialized")
    expect(first.ok).toBe(true)
    expect(statuses(first.results)).toEqual({ "//:build": "ran", "//:materialized": "ran" })
    expect(await Fs.readFile(NodePath.join(root, "dist", "a.txt"), "utf8")).toBe("built")
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("file")
  })

  it("checks an uncacheable producer's declared outputs on disk", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
const build = S.Shell.Build({
  shell: "mkdir -p dist && printf built > dist/a.txt && printf file > out.txt",
  outDirs: ["dist"], outFiles: ["out.txt"], cache: false
})
export const Package = S.Package({ targets: { build, materialized: S.Materialize(build) } })
`)
    const materialized = await run(root, "//:materialized")
    expect(materialized.ok).toBe(true)
    expect(statuses(materialized.results)).toEqual({ "//:build": "ran", "//:materialized": "ran" })
  })
})

describe("inert GitHub declarations executed directly", () => {
  it("answers a Github.Setup declaration green without running anything", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { setup: S.Github.Setup({}) } })
`)
    const executed = await run(root, "//:setup")
    expect(executed.ok).toBe(true)
    expect(executed.results).toMatchObject([{ label: "//:setup", status: "ran" }])
  })

  it.each([
    [1, "1 run entry has no label"],
    [2, "2 run entries have no label"]
  ])("refuses a workflow with %i unlabeled run entr(ies)", async (count, message) => {
    const runs = Array.from({ length: count }, (_, index) => `S.Shell.Test({ shell: "exit ${index}" })`).join(", ")
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  ci: S.Github.Workflow({ name: "ci", on: { pullRequest: true }, run: [${runs}] })
} })
`)
    const executed = await run(root, "//:ci")
    const workflow = executed.results.find((entry) => entry.label === "//:ci")
    expect(workflow).toMatchObject({ status: "failed" })
    expect(workflow?.error).toContain(message)
  })
})

describe("pre-act gates", () => {
  it("refuses a consumer whose declared gate is red and names every gate's status", async () => {
    const root = await fixture(`import { Smithers as S } from "@smthrs/targets"
const green = S.Shell.Test({ shell: "true" })
const red = S.Shell.Test({ shell: "exit 3" })
export const Package = S.Package({ targets: {
  green, red,
  gated: S.Shell.Run({ shell: "touch ran.txt", gates: [green, red] })
} })
`)
    const executed = await run(root, "//:gated")
    const gated = executed.results.find((entry) => entry.label === "//:gated")
    expect(gated).toMatchObject({ status: "failed" })
    expect(gated?.error).toBe("refused: gate //:red is not green (gates: //:green=ran, //:red=failed)")
    expect(await exists(NodePath.join(root, "ran.txt"))).toBe(false)
  })
})
