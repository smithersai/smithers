/**
 * `smthrs ci --shard` through the real CLI: every part runs its own roots,
 * the parts cover the selection once, and `--timings` moves the split.
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

/** Four roots; `a` and `b` share the dependency `shared`. */
const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-ci-shard-")))
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
const shared = S.Shell.Test({ shell: "true" })
const a = S.Shell.Test({ shell: "true", data: [shared] })
const b = S.Shell.Test({ shell: "true", data: [shared] })
const c = S.Shell.Test({ shell: "true" })
const d = S.Shell.Test({ shell: "true" })
export const Package = S.Package({ targets: { shared, a, b, c, d } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

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
  }).serve([...normalizeArgv(args), "--workspace", root, "--no-cache"], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      stdout += text
    }
  })
  return { exitCode, stderr, stdout }
}

const labels = async (file: string): Promise<ReadonlyArray<string>> => {
  const parsed = JSON.parse(await Fs.readFile(file, "utf8")) as {
    readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  expect(parsed.results.every((row) => row.status === "ran")).toBe(true)
  return parsed.results.map((row) => row.label)
}

const timings = (durations: Readonly<Record<string, number>>): string =>
  JSON.stringify({
    results: Object.entries(durations).map(([label, durationMs]) => ({ label, status: "ran", durationMs })),
    version: 1
  })

describe("smthrs ci --shard", () => {
  it("runs each part's roots and their dependencies; the parts cover every root once", async () => {
    const root = await fixture()
    await write(root, "timings.json", timings({ "//:a": 900, "//:b": 300, "//:c": 300, "//:d": 300, "//:shared": 5 }))
    const ran: Array<ReadonlyArray<string>> = []
    for (const index of [1, 2]) {
      const results = NodePath.join(root, "out", `part-${index}.json`)
      const served = await serve(root, [
        "ci",
        "//...",
        "--shard",
        `${index}/2`,
        "--timings",
        "timings.json",
        "--results-file",
        results
      ])
      expect(served.exitCode, served.stderr + served.stdout).toBe(0)
      ran.push(await labels(results))
    }
    // 900 + the 5 ms dependency root against three 300s.
    expect(ran).toEqual([["//:shared", "//:a"], ["//:shared", "//:b", "//:c", "//:d"]])
  }, 120_000)

  it("splits by label without timings, and a later timings file moves the split", async () => {
    const root = await fixture()
    const even = await serve(root, ["ci", "//...", "--shard", "1/2", "--plan", "--format", "json"])
    expect(even.exitCode, even.stderr).toBe(0)
    expect((JSON.parse(even.stdout) as { readonly roots: ReadonlyArray<string> }).roots).toEqual([
      "//:a",
      "//:c",
      "//:shared"
    ])
    await write(root, "old.json", timings({ "//:a": 10, "//:b": 10, "//:c": 10, "//:d": 10, "//:shared": 10 }))
    await write(root, "new.json", timings({ "//:d": 10_000 }))
    const moved = await serve(root, [
      "ci",
      "//...",
      "--shard",
      "1/2",
      "--timings",
      "old.json",
      "--timings",
      "new.json",
      "--plan",
      "--format",
      "json"
    ])
    expect(moved.exitCode, moved.stderr).toBe(0)
    const plan = JSON.parse(moved.stdout) as {
      readonly roots: ReadonlyArray<string>
      readonly targets: ReadonlyArray<{ readonly label: string }>
    }
    expect(plan.roots).toEqual(["//:d"])
    expect(plan.targets.map((entry) => entry.label)).toEqual(["//:d"])
  }, 120_000)

  it("runs nothing, green, as a part past the roots", async () => {
    const root = await fixture()
    const results = NodePath.join(root, "out", "empty.json")
    const served = await serve(root, ["ci", "//:c", "--shard", "2/2", "--results-file", results])
    expect(served.exitCode, served.stderr + served.stdout).toBe(0)
    expect(await labels(results)).toEqual([])
  }, 120_000)

  it.each([
    [["--shard", "3/2"], "--shard expects <index>/<count> with 1 <= index <= count <= 1024, received"],
    [["--timings", "timings.json"], "--timings needs --shard"],
    [["--shard", "1/2", "--timings", "absent.json"], "absent.json: cannot read the timings"],
    [["--shard", "1/2", "--timings", "PACKAGE.ts"], "PACKAGE.ts: timings are not JSON"]
  ])("refuses %j before running a target", async (flags, message) => {
    const root = await fixture()
    const results = NodePath.join(root, "out", "refused.json")
    const served = await serve(root, ["ci", "//...", ...flags, "--results-file", results])
    expect(served.exitCode).toBe(1)
    expect(served.stderr + served.stdout).toContain(message)
    expect(await labels(results)).toEqual([])
  }, 120_000)
})
