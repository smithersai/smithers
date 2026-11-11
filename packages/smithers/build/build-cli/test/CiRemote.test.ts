/**
 * `smthrs ci --remote` through the real CLI: one coordinator places the parts
 * of a run on two machines that are this host in two fresh directories, ships
 * the tree, runs `ci` on each, and merges the results files.
 */
import * as HttpSandbox from "@smthrs/sandbox/HttpSandbox"
import { Effect } from "effect"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodeHttp from "node:http"
import type { AddressInfo } from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import type * as Reporter from "../src/Reporter.ts"
import { directoryMachines } from "./helpers/DirectoryMachines.ts"
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

/** The CLI a machine runs: this checkout's own entry point. */
const main = fileURLToPath(new URL("../src/main.js", import.meta.url))

/** Four roots; `a` and `b` share the dependency `shared`. */
const targets = `const shared = S.Shell.Test({ shell: "true" })
const a = S.Shell.Test({ shell: "true", data: [shared] })
const b = S.Shell.Test({ shell: "true", data: [shared] })
const c = S.Shell.Test({ shell: "true" })
const d = S.Shell.Test({ shell: "true" })
export const Package = S.Package({ targets: { shared, a, b, c, d } })
`

interface Fixture {
  readonly root: string
  /** The guest directory every declared remote works under. */
  readonly guest: string
}

/**
 * A workspace whose WORKSPACE.ts declares `remotes`, a record body that may
 * name `cli` (this checkout's CLI) and `workdir` (a fresh guest directory);
 * `undefined` declares no `remotes` option at all.
 */
const fixture = async (remotes: string | undefined, packageTargets: string = targets): Promise<Fixture> => {
  const root = await temporary("smthrs-ci-remote-")
  const guest = await temporary("smthrs-ci-remote-guest-")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
const cli = ["node", ${JSON.stringify(main)}]
const workdir = ${JSON.stringify(guest)}
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
${remotes === undefined ? "" : `  remotes: S.Remotes({ ${remotes} })\n`}})
`
  )
  await write(root, "PACKAGE.ts", `import { Smithers as S } from "@smthrs/targets"\n${packageTargets}`)
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("add", "-A")
  git("-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return { root, guest }
}

const serve = async (
  root: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
  cache: ReadonlyArray<string> = ["--no-cache"],
  environment: Readonly<Record<string, string>> = {}
) => {
  let stderr = ""
  let stdout = ""
  const terminal = (sink: (text: string) => void): Reporter.Terminal => ({ write: sink, isTTY: false, columns: 100 })
  let exitCode = 0
  await makeCli({
    environment: { ...process.env, SMITHERS_AUDIENCE: "agent", NO_COLOR: "1", CI: undefined, ...environment },
    signal,
    stdout: terminal((text) => {
      stdout += text
    }),
    stderr: terminal((text) => {
      stderr += text
    })
  }).serve([...normalizeArgv(args), "--workspace", root, ...cache], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      stdout += text
    }
  })
  return { exitCode, stderr, stdout }
}

interface ResultRow {
  readonly label: string
  readonly status: string
  readonly durationMs: number
}

const results = async (file: string): Promise<{ readonly ok?: boolean; readonly results: ReadonlyArray<ResultRow> }> =>
  JSON.parse(await Fs.readFile(file, "utf8")) as { readonly ok?: boolean; readonly results: ReadonlyArray<ResultRow> }

/** The labels each machine reported settling, from the prefixed lines the coordinator streamed. */
const ranOn = (stderr: string): Readonly<Record<string, ReadonlyArray<string>>> => {
  const machines: Record<string, Array<string>> = {}
  // A machine's own environment may ask for colour.
  // eslint-disable-next-line no-control-regex
  for (
    const [, machine, label] of stderr.replaceAll(/\u001b\[[0-9;]*m/g, "").matchAll(
      /^machine (\d+): (\/\/:\w+) {2}(?:ran|failed)\b/gm
    )
  ) {
    ;(machines[machine!] ??= []).push(label!)
  }
  return Object.fromEntries(Object.entries(machines).map(([machine, labels]) => [machine, labels.sort()]))
}

const timings = (durations: Readonly<Record<string, number>>): string =>
  JSON.stringify({
    results: Object.entries(durations).map(([label, durationMs]) => ({ label, status: "ran", durationMs })),
    version: 1
  })

const pair = "pair: S.Remote.Command({ machines: [[], []], workdir, cli })"

/** A CLI wrapper for one machine: logs each call to `log`, then runs `body` (shell text) in place of the CLI. */
const wrapper = async (body: (log: string) => string): Promise<{ readonly script: string; readonly log: string }> => {
  const directory = await temporary("smthrs-ci-remote-cli-")
  const script = NodePath.join(directory, "cli.sh")
  const log = NodePath.join(directory, "calls")
  await Fs.writeFile(script, `echo call >> ${JSON.stringify(log)}\n${body(JSON.stringify(log))}\n`)
  return { script, log }
}

/**
 * A loopback HTTP service answering `HttpSandbox.serve` over sticky directory
 * machines under `machines`; counts the requests it answered.
 */
const machineService = async (token: string) => {
  const machines = await temporary("smthrs-ci-remote-machines-")
  const handler = HttpSandbox.serve({ provider: await directoryMachines(machines), token })
  let requests = 0
  const server = NodeHttp.createServer((incoming, outgoing) => {
    requests += 1
    void (async () => {
      const chunks: Array<Buffer> = []
      for await (const chunk of incoming) chunks.push(chunk as Buffer)
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method!,
        headers: incoming.headers as Record<string, string>,
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) })
      })
      const response = await Effect.runPromise(handler(request))
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    machines,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const calls = async (log: string): Promise<number> =>
  (await Fs.readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "").length

const planOf = (stdout: string) =>
  JSON.parse(stdout) as {
    readonly roots: ReadonlyArray<string>
    readonly remote: {
      readonly name: string
      readonly machines: ReadonlyArray<{ readonly machine: number; readonly roots: ReadonlyArray<string> }>
    }
  }

describe("smthrs ci --remote", () => {
  it("runs every root once across the machines, a shared dependency on both, and merges the results", async () => {
    const { guest, root } = await fixture(pair)
    await write(root, "timings.json", timings({ "//:a": 900, "//:b": 300, "//:c": 300, "//:d": 300, "//:shared": 5 }))
    const file = NodePath.join(root, "out", "remote.json")
    const served = await serve(root, [
      "ci",
      "//...",
      "--remote",
      "pair",
      "--timings",
      "timings.json",
      "--results-file",
      file,
      "--verbose"
    ])
    expect(served.exitCode, served.stderr + served.stdout).toBe(0)
    // 900 + the 5 ms dependency root against three 300s, as --shard splits them.
    expect(ranOn(served.stderr)).toEqual({ "1": ["//:a", "//:shared"], "2": ["//:b", "//:c", "//:d", "//:shared"] })
    const merged = await results(file)
    expect(merged.ok).toBe(true)
    expect(merged.results.map((row) => [row.label, row.status])).toEqual([
      ["//:shared", "ran"],
      ["//:a", "ran"],
      ["//:b", "ran"],
      ["//:c", "ran"],
      ["//:d", "ran"]
    ])
    // The merged file is a --timings file for the next run.
    const next = await serve(root, [
      "ci",
      "//...",
      "--remote",
      "pair",
      "--timings",
      "out/remote.json",
      "--plan",
      "--format",
      "json"
    ])
    expect(next.exitCode, next.stderr).toBe(0)
    expect(planOf(next.stdout).remote.machines.flatMap((part) => part.roots).sort()).toEqual([
      "//:a",
      "//:b",
      "//:c",
      "//:d",
      "//:shared"
    ])
    // Each part's directory is removed once its results are read.
    expect(await Fs.readdir(guest)).toEqual([])
  }, 300_000)

  it("fails the merged run and its results file when a target fails on a machine", async () => {
    const { root } = await fixture(
      pair,
      `const bad = S.Shell.Test({ shell: "exit 1" })
const good = S.Shell.Test({ shell: "true" })
export const Package = S.Package({ targets: { bad, good } })
`
    )
    const file = NodePath.join(root, "out", "remote.json")
    const served = await serve(root, ["ci", "//...", "--remote", "pair", "--results-file", file])
    expect(served.exitCode).toBe(1)
    const merged = await results(file)
    expect(merged.ok).toBe(false)
    expect(merged.results.map((row) => [row.label, row.status])).toEqual([["//:bad", "failed"], ["//:good", "ran"]])
  }, 300_000)

  it("prints each machine's roots under --plan, moved by --timings, and runs nothing", async () => {
    const { guest, root } = await fixture(pair)
    const even = await serve(root, ["ci", "//...", "--remote", "pair", "--plan", "--format", "json"])
    expect(even.exitCode, even.stderr).toBe(0)
    expect(planOf(even.stdout).remote).toEqual({
      name: "pair",
      machines: [{ machine: 1, roots: ["//:a", "//:c", "//:shared"] }, { machine: 2, roots: ["//:b", "//:d"] }]
    })
    await write(root, "slow.json", timings({ "//:a": 10, "//:b": 10, "//:c": 10, "//:d": 10_000, "//:shared": 10 }))
    const moved = await serve(root, [
      "ci",
      "//...",
      "--remote",
      "pair",
      "--timings",
      "slow.json",
      "--plan",
      "--format",
      "json"
    ])
    expect(moved.exitCode, moved.stderr).toBe(0)
    expect(planOf(moved.stdout).remote.machines).toEqual([
      { machine: 1, roots: ["//:d"] },
      { machine: 2, roots: ["//:a", "//:b", "//:c", "//:shared"] }
    ])
    expect(await Fs.readdir(guest)).toEqual([])
  }, 300_000)

  it.each([
    [["--remote", "absent"], "--remote absent is not declared; the workspace declares pair (S.Workspace remotes)"],
    [["--remote", "pair", "--shard", "1/2"], "--remote and --shard are exclusive"],
    [["--remote", "pair", "--known-red", "known.json"], "--remote does not take --known-red yet"],
    [["--timings", "timings.json"], "--timings needs --shard or --remote"]
  ])("refuses %j before running a target", async (flags, message) => {
    const { guest, root } = await fixture(pair)
    const file = NodePath.join(root, "out", "refused.json")
    const served = await serve(root, ["ci", "//...", ...flags, "--results-file", file])
    expect(served.exitCode).toBe(1)
    expect(served.stderr + served.stdout).toContain(message)
    expect((await results(file)).results).toEqual([])
    expect(await Fs.readdir(guest)).toEqual([])
  }, 120_000)

  it.each([["no remotes option", undefined], ["an empty S.Remotes", ""]])(
    "refuses --remote in a workspace with %s",
    async (_, remotes) => {
      const { root } = await fixture(remotes)
      const served = await serve(root, ["ci", "//...", "--remote", "pair"])
      expect(served.exitCode).toBe(1)
      expect(served.stderr + served.stdout).toContain(
        "--remote pair is not declared; the workspace declares no remotes"
      )
    },
    120_000
  )

  it("hands every machine the coordinator's cache, jobs and fail-fast flags", async () => {
    const recorder = await wrapper((log) => `echo "$@" >> ${log}\nexec node ${JSON.stringify(main)} "$@"`)
    const { root } = await fixture(
      `recorded: S.Remote.Command({ machines: [[]], workdir, cli: ["sh", ${JSON.stringify(recorder.script)}] })`
    )
    const first = await serve(
      root,
      ["ci", "//:c", "--remote", "recorded", "--jobs", "1", "--fail-fast", "--cache-dir", ".other"],
      undefined,
      []
    )
    expect(first.exitCode, first.stderr + first.stdout).toBe(0)
    const second = await serve(root, ["ci", "//:c", "--remote", "recorded"])
    expect(second.exitCode, second.stderr + second.stdout).toBe(0)
    const argv = (await Fs.readFile(recorder.log, "utf8")).split("\n").filter((line) => line.startsWith("ci "))
    expect(argv.map((line) => line.replace(/--results-file \S+/, "--results-file <file>"))).toEqual([
      "ci //:c --results-file <file> --audience human --ui plain --cache-dir .other --jobs 1 --fail-fast",
      "ci //:c --results-file <file> --audience human --ui plain --no-cache"
    ])
  }, 300_000)

  it("runs setup in the shipped tree before the targets, and fails the part's roots when setup fails", async () => {
    const { root } = await fixture(
      `prepared: S.Remote.Command({ machines: [[]], workdir, cli, setup: ["echo ready > setup-marker"] }),
  unprepared: S.Remote.Command({ machines: [[]], workdir, cli, setup: ["exit 4"] })`,
      `// Unconfined, so the target sees the whole shipped tree, setup's marker included.
const ready = S.Shell.Test({ shell: "test -f setup-marker", sandbox: "none" })
export const Package = S.Package({ targets: { ready } })
`
    )
    const prepared = NodePath.join(root, "out", "prepared.json")
    const served = await serve(root, ["ci", "//...", "--remote", "prepared", "--results-file", prepared, "--verbose"])
    expect(served.exitCode, served.stderr + served.stdout).toBe(0)
    expect((await results(prepared)).results.map((row) => [row.label, row.status])).toEqual([["//:ready", "ran"]])
    const unprepared = NodePath.join(root, "out", "unprepared.json")
    const failed = await serve(root, [
      "ci",
      "//...",
      "--remote",
      "unprepared",
      "--results-file",
      unprepared,
      "--verbose"
    ])
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toContain("//:ready  failed  0ms  setup `exit 4` exited 4 on machine 1")
    expect((await results(unprepared)).results.map((row) => [row.label, row.status])).toEqual([["//:ready", "failed"]])
  }, 300_000)

  it("retries a lost machine once, then reports its roots failed while the other machine's results stand", async () => {
    const { guest, root } = await fixture("lossy: S.Remote.Command({ machines: [[], [\"false\"]], workdir, cli })")
    const file = NodePath.join(root, "out", "remote.json")
    const served = await serve(root, ["ci", "//...", "--remote", "lossy", "--results-file", file, "--verbose"])
    expect(served.exitCode).toBe(1)
    expect(served.stderr).toMatch(/^\/\/:b {2}failed {2}0ms {2}machine 2 was lost: /m)
    expect((await results(file)).results.map((row) => [row.label, row.status])).toEqual([
      ["//:shared", "ran"],
      ["//:a", "ran"],
      ["//:b", "failed"],
      ["//:c", "ran"],
      ["//:d", "failed"]
    ])
    expect(await Fs.readdir(guest)).toEqual([])
  }, 300_000)

  it("runs a lost part again on a fresh session, and gives up after the second loss", async () => {
    // The first call writes no results file; every later call is the real CLI.
    const once = await wrapper((log) =>
      `[ "$(grep -c call ${log})" -gt 1 ] || exit 3
exec node ${JSON.stringify(main)} "$@"`
    )
    const never = await wrapper(() => "exit 3")
    const { root } = await fixture(
      `once: S.Remote.Command({ machines: [[]], workdir, cli: ["sh", ${JSON.stringify(once.script)}] }),
  never: S.Remote.Command({ machines: [[]], workdir, cli: ["sh", ${JSON.stringify(never.script)}] })`
    )
    const recovered = NodePath.join(root, "out", "recovered.json")
    const served = await serve(root, ["ci", "//:c", "--remote", "once", "--results-file", recovered])
    expect(served.exitCode, served.stderr + served.stdout).toBe(0)
    expect(await calls(once.log)).toBe(2)
    expect((await results(recovered)).results.map((row) => [row.label, row.status])).toEqual([["//:c", "ran"]])
    const lost = NodePath.join(root, "out", "lost.json")
    const failed = await serve(root, ["ci", "//:c", "--remote", "never", "--results-file", lost, "--verbose"])
    expect(failed.exitCode).toBe(1)
    expect(await calls(never.log)).toBe(2)
    expect(failed.stderr).toContain("//:c  failed  0ms  machine 1 was lost: `ci` exited 3 and wrote no results file")
  }, 300_000)

  it("runs the parts on machines an HTTP service holds, and refuses an unset token before contacting it", async () => {
    const service = await machineService("machines-token")
    try {
      const { guest, root } = await fixture(
        `web: S.Remote.Http({ url: ${
          JSON.stringify(service.url)
        }, token: S.Secret("SMITHERS_TEST_MACHINES_TOKEN"), machines: 2, workdir, cli })`
      )
      const refused = await serve(root, ["ci", "//...", "--remote", "web"])
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr + refused.stdout).toContain(
        "the remote's token is not set: export SMITHERS_TEST_MACHINES_TOKEN"
      )
      expect(service.requests()).toBe(0)

      const file = NodePath.join(root, "out", "remote.json")
      const served = await serve(
        root,
        ["ci", "//...", "--remote", "web", "--results-file", file, "--verbose"],
        undefined,
        ["--no-cache"],
        { SMITHERS_TEST_MACHINES_TOKEN: "machines-token" }
      )
      expect(served.exitCode, served.stderr + served.stdout).toBe(0)
      expect(Object.keys(ranOn(served.stderr)).sort(), served.stderr).toEqual(["1", "2"])
      const merged = await results(file)
      expect(merged.ok).toBe(true)
      expect(merged.results.map((row) => [row.label, row.status])).toEqual([
        ["//:shared", "ran"],
        ["//:a", "ran"],
        ["//:b", "ran"],
        ["//:c", "ran"],
        ["//:d", "ran"]
      ])
      // Every part's directory is removed, and the service destroyed every machine it started.
      expect(await Fs.readdir(guest)).toEqual([])
      expect(await Fs.readdir(service.machines)).toEqual([])
    } finally {
      await service.close()
    }
  }, 300_000)

  it("closes every session when the run is interrupted", async () => {
    const pidFile = NodePath.join(await temporary("smthrs-ci-remote-pid-"), "pid")
    const hang = await wrapper(() => `echo $$ > ${JSON.stringify(pidFile)}\nexec sleep 600`)
    const { guest, root } = await fixture(
      `hang: S.Remote.Command({ machines: [[]], workdir, cli: ["sh", ${JSON.stringify(hang.script)}] })`
    )
    const controller = new AbortController()
    const serving = serve(root, ["ci", "//:c", "--remote", "hang"], controller.signal)
    const deadline = Date.now() + 120_000
    while ((await Fs.readFile(pidFile, "utf8").catch(() => "")).trim() === "") {
      if (Date.now() > deadline) throw new Error("the machine never started the CLI")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const pid = Number((await Fs.readFile(pidFile, "utf8")).trim())
    controller.abort()
    const served = await serving
    expect(served.exitCode).toBe(1)
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    while (alive()) {
      if (Date.now() > deadline) throw new Error(`the machine's CLI ${pid} outlived the interrupted run`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(await Fs.readdir(guest)).toEqual([])
  }, 300_000)
})
