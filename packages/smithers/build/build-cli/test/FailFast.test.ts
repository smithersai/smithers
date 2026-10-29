/**
 * `smthrs ci --fail-fast` through the real CLI: the first blocking failure
 * stops the run, kills the running targets' processes, and records every
 * unfinished target as cancelled. A known-red failure does not stop it.
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

const temporary = async (prefix: string): Promise<string> => {
  const directory = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * `bad` fails only once `slow` has started its 60-second sleep, so the sleep
 * is running when the run stops. Both share a pid file outside the workspace,
 * which the default confinement would refuse to write. `later` waits on `slow` and `consumer` on
 * `bad`, so neither has started by then.
 */
const fixture = async (): Promise<{ readonly root: string; readonly pidFile: string }> => {
  const root = await temporary("smthrs-fail-fast-cli-")
  const pidFile = NodePath.join(await temporary("smthrs-fail-fast-pid-"), "slow.pid")
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
const pid = ${JSON.stringify(pidFile)}
const bad = S.Shell.Test({
  shell: \`while [ ! -s "\${pid}" ]; do sleep 0.05; done; echo reviewed failure >&2; exit 1\`,
  sandbox: "none"
})
const slow = S.Shell.Test({ shell: \`sleep 60 & echo $! > "\${pid}"; wait\`, sandbox: "none" })
const later = S.Shell.Test({ shell: "true", data: [slow] })
const consumer = S.Shell.Test({ shell: "true", data: [bad] })
const known = S.Shell.Test({ shell: "echo reviewed failure >&2; exit 1" })
const quick = S.Shell.Test({ shell: "true" })
export const Package = S.Package({ targets: { bad, slow, later, consumer, known, quick } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return { root, pidFile }
}

const serve = async (root: string, args: ReadonlyArray<string>) => {
  let stderr = ""
  const terminal: Reporter.Terminal = {
    write: (text) => {
      stderr += text
    },
    isTTY: false,
    columns: 100
  }
  let exitCode = 0
  await makeCli({
    environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined },
    stdout: { write: () => undefined, isTTY: false, columns: 100 },
    stderr: terminal
  }).serve([...normalizeArgv(args), "--workspace", root, "--no-cache"], {
    exit: (code) => {
      exitCode = code
    },
    stdout: () => undefined
  })
  return { exitCode, stderr }
}

const statuses = async (file: string): Promise<Record<string, string>> => {
  const parsed = JSON.parse(await Fs.readFile(file, "utf8")) as {
    readonly results: ReadonlyArray<{ readonly label: string; readonly status: string }>
  }
  return Object.fromEntries(parsed.results.map((row) => [row.label, row.status]))
}

describe("smthrs ci --fail-fast", () => {
  it("stops at the first failure, kills running targets and records the rest as cancelled", async () => {
    const { root, pidFile } = await fixture()
    const results = NodePath.join(root, "out", "results.json")
    const started = performance.now()
    const served = await serve(root, [
      "ci",
      "//:bad",
      "//:later",
      "//:consumer",
      "--fail-fast",
      "--verbose",
      "--jobs",
      "2",
      "--results-file",
      results
    ])
    const elapsed = performance.now() - started
    expect(served.exitCode).toBe(1)
    expect(elapsed).toBeLessThan(30_000)
    const sleeper = Number((await Fs.readFile(pidFile, "utf8")).trim())
    expect(sleeper).toBeGreaterThan(0)
    expect(alive(sleeper)).toBe(false)
    expect(await statuses(results)).toEqual({
      "//:bad": "failed",
      "//:slow": "cancelled",
      "//:later": "cancelled",
      "//:consumer": "cancelled"
    })
    expect(served.stderr).toMatch(/\/\/:slow\s+cancelled\s+.*cancelled: --fail-fast stopped the run after \/\/:bad/)
    expect(served.stderr).toMatch(/\/\/:later\s+cancelled\s+.*not started: --fail-fast stopped the run after \/\/:bad/)
  }, 60_000)

  it("keeps going past a failure the known-red list excuses", async () => {
    const { root } = await fixture()
    await write(root, "known-red.json", JSON.stringify({ entries: [] }))
    const first = await serve(root, ["ci", "//:known", "--known-red", "known-red.json"])
    const failureDigest = first.stderr.match(/observed failure: \/\/:known (sha256:[a-f0-9]{64})/)?.[1]
    expect(failureDigest).toBeDefined()
    await write(
      root,
      "known-red.json",
      JSON.stringify({
        entries: [{
          label: "//:known",
          owner: "will",
          reason: "red on main",
          issue: "https://github.com/smithersai/smithers/issues/1",
          expires: "2999-01-01",
          failureDigest
        }]
      })
    )
    const results = NodePath.join(root, "out", "known.json")
    const served = await serve(root, [
      "ci",
      "//:known",
      "//:quick",
      "--fail-fast",
      "--jobs",
      "1",
      "--known-red",
      "known-red.json",
      "--results-file",
      results
    ])
    expect(served.exitCode).toBe(0)
    expect(served.stderr).toContain("known red (known-red.json): //:known")
    expect(await statuses(results)).toEqual({ "//:known": "failed", "//:quick": "ran" })
  }, 60_000)

  it("runs every target without the flag", async () => {
    const { root } = await fixture()
    const results = NodePath.join(root, "out", "all.json")
    const served = await serve(root, ["ci", "//:known", "//:quick", "--jobs", "1", "--results-file", results])
    expect(served.exitCode).toBe(1)
    expect(await statuses(results)).toEqual({ "//:known": "failed", "//:quick": "ran" })
  }, 60_000)
})
