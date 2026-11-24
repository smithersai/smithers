/**
 * `--shard <index>/<count>` through the real CLI: every planned label belongs
 * to exactly one shard, a shard builds a dependency another shard owns unless
 * the cache already holds it, the record names the shard, and a bad value is
 * refused before anything runs.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import type * as Reporter from "../src/Reporter.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

/**
 * A file group and four tests; `a` and `b` read the file group `shared`.
 * Among two shards, shard 0 owns `shared`, `a` and `c`, and shard 1 owns `b`
 * and `d`.
 */
const fixture = async (initializeRepository = true): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-shard-")))
  temporaryDirectories.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const shared = S.Filegroup({ srcs: [S.file("README.md")] })
const a = S.Shell.Test({ shell: "echo a", data: [shared] })
const b = S.Shell.Test({ shell: "echo b", data: [shared] })
const c = S.Shell.Test({ shell: "echo c" })
const d = S.Shell.Test({ shell: "echo d" })
export const Package = S.Package({ targets: { shared, a, b, c, d } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  await write(root, "README.md", "shared\n")
  if (!initializeRepository) return root
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

const all = ["//:shared", "//:a", "//:b", "//:c", "//:d"]

const serve = async (root: string, args: ReadonlyArray<string>) => {
  let stderr = ""
  let stdout = ""
  const terminal = (sink: (text: string) => void): Reporter.Terminal => ({ write: sink, isTTY: false, columns: 100 })
  let exitCode = 0
  await makeCli({
    environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined },
    stdout: terminal((text) => {
      stdout += text
    }),
    stderr: terminal((text) => {
      stderr += text
    })
  }).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      stdout += text
    }
  })
  return { exitCode, stderr, stdout }
}

interface Record {
  readonly ok: boolean
  readonly shard?: { readonly index: number; readonly count: number }
  readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
}

const record = async (file: string): Promise<Record> => JSON.parse(await Fs.readFile(file, "utf8")) as Record

/** Each result as `<label> <status>`, sorted: targets settle in any order. */
const statuses = (run: Record): ReadonlyArray<string> => run.results.map((row) => `${row.label} ${row.status}`).sort()

interface Plan {
  readonly roots: ReadonlyArray<string>
  readonly targets: ReadonlyArray<{ readonly label: string }>
}

const plan = async (root: string, verb: string, shard: string): Promise<Plan> => {
  const served = await serve(root, [verb, "//...", "--shard", shard, "--plan", "--format", "json"])
  expect(served.exitCode, served.stderr).toBe(0)
  return JSON.parse(served.stdout) as Plan
}

describe("--shard", () => {
  it.each(["ci", "test"])("gives every label %s plans exactly one shard, for several counts", async (verb) => {
    const root = await fixture()
    for (const count of [1, 2, 3, 4, 7]) {
      const owned: Array<string> = []
      for (let index = 0; index < count; index++) {
        const part = await plan(root, verb, `${index}/${count}`)
        owned.push(...part.roots)
        // A shard plans its own labels and their dependencies, nothing else.
        const needed = new Set(part.roots)
        if (part.roots.includes("//:a") || part.roots.includes("//:b")) needed.add("//:shared")
        expect(part.targets.map((target) => target.label).sort()).toEqual([...needed].sort())
      }
      expect(owned.sort()).toEqual([...all].sort())
    }
  }, 300_000)

  it("plans the shards the label rule assigns", async () => {
    const root = await fixture()
    expect(await plan(root, "ci", "0/2")).toMatchObject({ roots: ["//:shared", "//:a", "//:c"] })
    expect(await plan(root, "ci", "1/2")).toMatchObject({
      roots: ["//:b", "//:d"],
      targets: [{ label: "//:shared" }, { label: "//:b" }, { label: "//:d" }]
    })
  }, 120_000)

  it("builds a dependency another shard owns, unless the cache already holds it", async () => {
    const root = await fixture()
    const out = (name: string) => NodePath.join(root, "out", `${name}.json`)
    // Shard 1 needs //:shared, which shard 0 owns, and the cache is empty: it runs it.
    expect((await serve(root, ["ci", "//...", "--shard", "1/2", "--results-file", out("first")])).exitCode).toBe(0)
    const first = await record(out("first"))
    expect(statuses(first)).toEqual(["//:b ran", "//:d ran", "//:shared ran"])
    expect(first.shard).toEqual({ index: 1, count: 2 })
    // Shard 0 owns //:shared and finds it in the cache: together the two shards ran every target once.
    expect((await serve(root, ["ci", "//...", "--shard", "0/2", "--results-file", out("second")])).exitCode).toBe(0)
    const second = await record(out("second"))
    expect(statuses(second)).toEqual(["//:a ran", "//:c ran", "//:shared hit"])
    expect(second.shard).toEqual({ index: 0, count: 2 })
    const ran = [...first.results, ...second.results].filter((row) => row.status === "ran").map((row) => row.label)
    expect(ran.sort()).toEqual([...all].sort())
  }, 120_000)

  it("runs a dependency again with --no-cache, and names the shard in the JSON summary", async () => {
    const root = await fixture()
    await serve(root, ["ci", "//...", "--shard", "0/2"])
    const served = await serve(root, ["test", "//...", "--shard", "1/2", "--no-cache", "--format", "json"])
    expect(served.exitCode, served.stderr).toBe(0)
    const summary = JSON.parse(served.stdout) as Record
    expect(statuses(summary)).toEqual(["//:b ran", "//:d ran", "//:shared ran"])
    expect(summary.shard).toEqual({ index: 1, count: 2 })
  }, 120_000)

  it("runs nothing, green, as a shard that owns no selected label", async () => {
    const root = await fixture()
    const results = NodePath.join(root, "out", "empty.json")
    const served = await serve(root, ["ci", "//:c", "--shard", "1/2", "--results-file", results])
    expect(served.exitCode, served.stderr + served.stdout).toBe(0)
    expect(await record(results)).toMatchObject({ ok: true, results: [], shard: { index: 1, count: 2 } })
  }, 120_000)

  it("leaves an unsharded record without a shard", async () => {
    const root = await fixture()
    const results = NodePath.join(root, "out", "whole.json")
    expect((await serve(root, ["lint", "//...", "--results-file", results])).exitCode).toBe(0)
    expect(await record(results)).not.toHaveProperty("shard")
  }, 120_000)

  it.each([
    ["ci", "2/2"],
    ["ci", "1/0"],
    ["test", "-1/2"],
    ["build", "1"],
    ["lint", "a/b"],
    ["docs", "0/1025"]
  ])("refuses %s --shard %j before running a target", async (verb, shard) => {
    const root = await fixture()
    const results = NodePath.join(root, "out", "refused.json")
    const served = await serve(root, [verb, "//...", "--shard", shard, "--results-file", results])
    expect(served.exitCode).toBe(1)
    const output = served.stderr + served.stdout
    expect(output).toContain("--shard expects <index>/<count> with 0 <= index < count <= 1024, received")
    expect(output).toContain(shard)
    expect(await record(results)).toEqual({ results: [], version: 1 })
  }, 120_000)

  it("shards the targets a change affects", async () => {
    const root = await fixture()
    const affected = async (shard: ReadonlyArray<string>): Promise<Plan> => {
      const served = await serve(root, [
        "affected",
        "test",
        "//...",
        "--files",
        "README.md",
        ...shard,
        "--plan",
        "--format",
        "json"
      ])
      expect(served.exitCode, served.stderr).toBe(0)
      return JSON.parse(served.stdout) as Plan
    }
    const whole = await affected([])
    const parts = [await affected(["--shard", "0/2"]), await affected(["--shard", "1/2"])]
    expect(whole.roots).toContain("//:b")
    // The two shards own every target the change affects, once.
    expect(parts.flatMap((part) => part.roots).sort()).toEqual(whole.targets.map((target) => target.label).sort())
    // Shard 1 owns //:b and plans //:shared, which shard 0 owns, as its dependency.
    expect(parts[1]!.roots).toContain("//:b")
    expect(parts[1]!.roots).not.toContain("//:shared")
    expect(parts[1]!.targets.map((target) => target.label)).toContain("//:shared")
  }, 120_000)

  it("executes a named affected Suite and records its member", async () => {
    const root = await fixture(false)
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const member = S.Shell.Test({ shell: "echo member", data: [S.file("README.md")] })
export const Package = S.Package({ targets: { member, suite: S.Suite({ tests: [member] }) } })
`
    )
    const served = await serve(root, ["affected", "test", "//:suite", "--files", "README.md", "--format", "json"])
    expect(served.exitCode, served.stderr + served.stdout).toBe(0)
    expect(statuses(JSON.parse(served.stdout) as Record)).toEqual(["//:member ran", "//:suite ran"])
  }, 120_000)

  it("records every affected gate owned by each executing shard", async () => {
    const root = await fixture(false)
    const run = async (flags: ReadonlyArray<string>) => {
      const served = await serve(root, [
        "affected",
        "test",
        "//...",
        "--files",
        "README.md",
        ...flags,
        "--format",
        "json"
      ])
      expect(served.exitCode, served.stderr + served.stdout).toBe(0)
      return (JSON.parse(served.stdout) as Record).results.map((row) => row.label).sort()
    }
    const whole = await run([])
    const first = await run(["--shard", "0/2"])
    const second = await run(["--shard", "1/2"])
    expect(first).toContain("//:a")
    expect(first).not.toContain("//:b")
    expect(second).toContain("//:b")
    expect([...new Set([...first, ...second])].sort()).toEqual(whole)
  }, 120_000)

  it("refuses affected --shard before reading the change", async () => {
    const root = await fixture()
    const served = await serve(root, ["affected", "test", "//...", "--shard", "01/2", "--base", "no-such-revision"])
    expect(served.exitCode).toBe(1)
    expect(served.stderr + served.stdout).toContain(
      "--shard expects <index>/<count> with 0 <= index < count <= 1024, received"
    )
  }, 120_000)

  it.each([
    [["--timings", "timings.json"], "--timings needs --remote"],
    [["--shard", "0/2", "--timings", "timings.json"], "--timings needs --remote"]
  ])("refuses %j", async (flags, message) => {
    const root = await fixture()
    const served = await serve(root, ["ci", "//...", ...flags])
    expect(served.exitCode).toBe(1)
    expect(served.stderr + served.stdout).toContain(message)
  }, 120_000)
})
