import * as SafeFs from "@smthrs/targets/SafeFs"
import { createHash } from "node:crypto"
import fsPromises, * as Fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import * as DigestIndexFile from "../src/internal/DigestIndexFile.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import type * as Reporter from "../src/Reporter.ts"

const roots: Array<string> = []

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-plan-digest-index-")))
  roots.push(root)
  const files: Record<string, string> = {
    "package.json": "{\"name\":\"plan-digest-index\",\"private\":true,\"type\":\"module\"}\n",
    "WORKSPACE.ts": `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const Workspace = S.Workspace("plan-digest-index", {
  repository: "git+https://example.invalid/plan-digest-index.git",
  cache: S.Cache({ directory: ".flows" }), runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})\n`,
    "PACKAGE.ts": `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  a: S.Shell.Test({ summary: "A.", shell: "true", data: [S.glob("src/a/**"), S.file("shared.txt")], sandbox: "none" }),
  b: S.Shell.Test({ summary: "B.", shell: "true", data: [S.glob("src/b/**"), S.file("shared.txt")], sandbox: "none" })
} })\n`,
    "shared.txt": "shared\n",
    "src/a/one.txt": "a one\n",
    "src/a/two.txt": "a two\n",
    "src/b/one.txt": "b one\n"
  }
  for (const [relative, contents] of Object.entries(files)) {
    const path = Path.join(root, relative)
    await Fs.mkdir(Path.dirname(path), { recursive: true })
    await Fs.writeFile(path, contents)
  }
  return root
}

/** An index whose clock reads past the settle window: the view of a later invocation. */
const later = () =>
  SafeFs.makeDigestIndex([], () => BigInt(Date.now()) * 1_000_000n + SafeFs.settledNanoseconds + 1_000_000_000n)

/** Plans `//...` and records which workspace data files the plan opened. */
const planned = async (root: string, digests?: SafeFs.DigestIndex) => {
  const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
  const opened: Array<string> = []
  const original = fsPromises.open
  vi.spyOn(fsPromises, "open").mockImplementation((path, ...rest) => {
    const relative = Path.relative(root, String(path))
    if (relative === "shared.txt" || relative.startsWith("src/")) opened.push(relative)
    return original(path, ...rest)
  })
  syncBuiltinESMExports()
  try {
    const plan = await PackageExec.plan({
      index,
      patterns: ["//..."],
      cacheDirectory: ".flows",
      verb: "test",
      ...(digests === undefined ? {} : { digests })
    })
    return { opened: opened.sort(), keys: new Map([...plan.nodes].map(([label, node]) => [label, node.keyPreview])) }
  } finally {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
  }
}

describe("plans remember file digests between invocations", () => {
  it("reads only the files that changed since the last plan, with the keys a fresh plan computes", async () => {
    const root = await workspace()
    const digests = later()
    const first = await planned(root, digests)
    expect(first.opened).toEqual(["shared.txt", "src/a/one.txt", "src/a/two.txt", "src/b/one.txt"])
    await DigestIndexFile.save(root, ".flows", digests)

    const unchanged = await planned(root)
    expect(unchanged.opened).toEqual([])
    expect(unchanged.keys).toEqual(first.keys)

    await new Promise((resolve) => setTimeout(resolve, 50))
    await Fs.writeFile(Path.join(root, "src/a/two.txt"), "a 2!\n")
    const edited = await planned(root)
    expect(edited.opened).toEqual(["src/a/two.txt"])
    expect(edited.keys.get("//:b")).toBe(first.keys.get("//:b"))
    expect(edited.keys.get("//:a")).not.toBe(first.keys.get("//:a"))

    await Fs.rm(DigestIndexFile.path(root, ".flows"))
    const fresh = await planned(root)
    expect(fresh.keys).toEqual(edited.keys)
  })

  it("reads every file again when the saved index cannot be trusted", async () => {
    const root = await workspace()
    const digests = later()
    const first = await planned(root, digests)
    await DigestIndexFile.save(root, ".flows", digests)
    const file = DigestIndexFile.path(root, ".flows")
    const saved = JSON.parse(await Fs.readFile(file, "utf8")) as { rows: string }
    const tampered = saved.rows.replace(/"[0-9a-f]{64}"/, `"${"0".repeat(64)}"`)
    const variants = [
      "not json",
      "[]",
      JSON.stringify({ ...saved, format: "smthrs-file-digests/0" }),
      JSON.stringify({ ...saved, rows: tampered }),
      JSON.stringify({ ...saved, rows: "{", check: sha256Of("{") }),
      JSON.stringify({ ...saved, rows: "[[1,2,3]]", check: sha256Of("[[1,2,3]]") })
    ]
    for (const text of variants) {
      await Fs.writeFile(file, text)
      const lines: Array<string> = []
      const loaded = await DigestIndexFile.load(root, ".flows", (line) => lines.push(line))
      expect(loaded.rows.size).toBe(0)
      expect(lines).toHaveLength(1)
      const again = await planned(root)
      expect(again.opened).toHaveLength(4)
      expect(again.keys).toEqual(first.keys)
    }
  })

  it("starts empty without a saved index and saves through a missing cache directory", async () => {
    const root = await workspace()
    const lines: Array<string> = []
    expect((await DigestIndexFile.load(root, ".flows", (line) => lines.push(line))).rows.size).toBe(0)
    expect(lines).toEqual([])
    const digests = later()
    await planned(root, digests)
    await DigestIndexFile.save(root, ".flows", digests)
    expect((await DigestIndexFile.load(root, ".flows")).rows.size).toBe(4)
    expect(await Fs.readFile(Path.join(root, ".flows/plan/.gitignore"), "utf8")).toBe("*\n")
    await DigestIndexFile.save(root, ".flows", digests)
  })

  it("leaves the saved index as it was when a plan remembers nothing new", async () => {
    const root = await workspace()
    const first = later()
    await planned(root, first)
    await DigestIndexFile.save(root, ".flows", first)
    const file = DigestIndexFile.path(root, ".flows")
    const before = await Fs.stat(file, { bigint: true })

    const unchanged = await DigestIndexFile.load(root, ".flows")
    expect((await planned(root, unchanged)).opened).toEqual([])
    await DigestIndexFile.save(root, ".flows", unchanged)
    const after = await Fs.stat(file, { bigint: true })
    expect([after.ino, after.mtimeNs, after.size]).toEqual([before.ino, before.mtimeNs, before.size])

    // One edited file is one replaced row, and the index is written again.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await Fs.writeFile(Path.join(root, "src/a/two.txt"), "a 2!\n")
    const edited = await DigestIndexFile.load(root, ".flows")
    expect((await planned(root, edited)).opened).toEqual(["src/a/two.txt"])
    await DigestIndexFile.save(root, ".flows", edited)
    const rewritten = await Fs.stat(file, { bigint: true })
    expect(rewritten.ino).not.toBe(before.ino)
    // The edit is too recent to be remembered, and the old digest is gone.
    const saved = await DigestIndexFile.load(root, ".flows")
    expect(saved.rows.has(Path.join(root, "src/a/two.txt"))).toBe(false)
    expect(saved.rows.has(Path.join(root, "src/a/one.txt"))).toBe(true)
  })

  it("writes the index again after a plan forgets a row", async () => {
    const root = await workspace()
    const first = later()
    await planned(root, first)
    await DigestIndexFile.save(root, ".flows", first)
    await Fs.rm(Path.join(root, "src/a/two.txt"))
    const loaded = await DigestIndexFile.load(root, ".flows")
    loaded.rows.delete(Path.join(root, "src/a/two.txt"))
    await DigestIndexFile.save(root, ".flows", loaded)
    expect((await DigestIndexFile.load(root, ".flows")).rows.has(Path.join(root, "src/a/two.txt"))).toBe(false)
  })

  it("persists clearing remembered rows and leaves an already empty index untouched", async () => {
    const root = await workspace()
    const file = Path.join(root, "src/a/one.txt")
    const index = SafeFs.makeDigestIndex([[file, { status: "settled", digest: "a".repeat(64), settled: true }]])
    index.used.add(file)
    await DigestIndexFile.save(root, ".flows", index)
    const loaded = await DigestIndexFile.load(root, ".flows")
    expect([...loaded.rows.keys()]).toEqual([file])

    loaded.rows.clear()
    await DigestIndexFile.save(root, ".flows", loaded)
    const empty = await DigestIndexFile.load(root, ".flows")
    expect(empty.rows.size).toBe(0)

    const saved = DigestIndexFile.path(root, ".flows")
    const before = await Fs.stat(saved, { bigint: true })
    empty.rows.clear()
    await DigestIndexFile.save(root, ".flows", empty)
    const after = await Fs.stat(saved, { bigint: true })
    expect([after.ino, after.mtimeNs, after.size]).toEqual([before.ino, before.mtimeNs, before.size])
  })

  it("saves only settled rows, the ones a plan used first", async () => {
    const root = await workspace()
    const digest = "a".repeat(64)
    const index = SafeFs.makeDigestIndex([
      ["/old", { status: "1", digest, settled: true }],
      ["/new", { status: "2", digest, settled: true }],
      ["/recent", { status: "3", digest, settled: false }]
    ])
    index.used.add("/new")
    index.used.add("/recent")
    await DigestIndexFile.save(root, ".flows", index)
    const loaded = await DigestIndexFile.load(root, ".flows")
    expect([...loaded.rows.keys()]).toEqual(["/new", "/old"])
  })

  it("logs a failed save and leaves nothing behind", async () => {
    const root = await workspace()
    await Fs.writeFile(Path.join(root, ".flows"), "a file where the cache directory goes\n")
    const lines: Array<string> = []
    await DigestIndexFile.save(root, ".flows", later(), (line) => lines.push(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/file digest index not saved/)
  })
})

const sha256Of = (text: string): string => createHash("sha256").update(text).digest("hex")

/** Runs the CLI in-process and records how often each workspace data file is opened. */
const servedOpens = async (root: string, args: ReadonlyArray<string>) => {
  const opened = new Map<string, number>()
  const original = fsPromises.open
  vi.spyOn(fsPromises, "open").mockImplementation((path, ...rest) => {
    const relative = Path.relative(root, String(path))
    if (relative.startsWith("src/")) opened.set(relative, (opened.get(relative) ?? 0) + 1)
    return original(path, ...rest)
  })
  syncBuiltinESMExports()
  let output = ""
  let exitCode = 0
  const terminal = (): Reporter.Terminal => ({ write: (text) => (output += text), isTTY: false, columns: 100 })
  try {
    await makeCli({
      environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined },
      stdout: terminal(),
      stderr: terminal()
    }).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => (exitCode = code),
      stdout: (text) => (output += text)
    })
  } finally {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
  }
  return { opened, exitCode, output }
}

describe("smthrs ci plans its verbs over one read of the tree", () => {
  it("opens each declared file once across the build and test plans", async () => {
    const root = await workspace()
    await Fs.writeFile(
      Path.join(root, "PACKAGE.ts"),
      `import { Smithers as S } from "@smthrs/targets"
const tree = S.Filegroup({ srcs: [S.glob("src/**")] })
export const Package = S.Package({ targets: {
  tree,
  built: S.Shell.Build({ summary: "Built.", shell: "true", data: [tree], outFiles: ["out/built.txt"], sandbox: "none" }),
  tested: S.Shell.Test({ summary: "Tested.", shell: "true", data: [tree], sandbox: "none" })
} })\n`
    )
    const served = await servedOpens(root, ["ci", "//...", "--plan", "--format", "json"])
    expect(served.exitCode, served.output).toBe(0)
    expect(Object.fromEntries(served.opened)).toEqual({ "src/a/one.txt": 1, "src/a/two.txt": 1, "src/b/one.txt": 1 })
    // Nothing had settled, so nothing outlives the invocation.
    expect((await DigestIndexFile.load(root, ".flows")).rows.size).toBe(0)
  })
})
