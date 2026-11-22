/**
 * A job whose step starts a server in the background for the steps after it. On a GitHub runner such a program
 * lives until the job's last step has ended, and the runner ends it then. The real program replays such jobs, and
 * the real `smthrs` runs the CI `apply` writes as a runner does: a server on a TCP port; a server that forks twice
 * into a session of its own, as `redis-server --daemonize yes` does, and answers on a Unix socket with a file it
 * reads; a commit that breaks only what the servers serve; and a commit that changes nothing the jobs read. A job
 * on macOS, whose runner has nothing that keeps a job's programs, stays in the repository's workflow.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { type AddressInfo, createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { compiledCode, notesPath, workspacePath } from "../../src/generate/Render.ts"
import { probe } from "../../src/replay/Jail.ts"
import { bin, commit, git, head, observes, remove, spawn } from "./repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const smthrs = fileURLToPath(new URL("../../../smithers/bin/smithers.mjs", import.meta.url))

/** A machine where a step's programs are kept: Linux with a bubblewrap that starts, and Python for the servers. */
const keeps = !("refusal" in probe()) && spawnSync("python3", ["--version"]).status === 0

/** A port nothing listens on now: the system's choice, let go at once. */
const port = await new Promise<number>((resolve) => {
  const probe = createServer()
  probe.listen(0, "127.0.0.1", () => {
    const { port: chosen } = probe.address() as AddressInfo
    probe.close(() => resolve(chosen))
  })
})

/** The reviewer's server: `serve` forks twice into a session of its own; `ask` gets a file through it, then ends it. */
const daemon = `# daemon.py serve <sock> | ask <sock> <path>
import os, socket, sys
if sys.argv[1] == "serve":
    if os.fork(): sys.exit(0)
    os.setsid()
    if os.fork(): sys.exit(0)
    for f in (0, 1, 2): os.close(f)
    os.open("/dev/null", os.O_RDWR); os.dup(0); os.dup(0)
    s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[2]); s.listen(1); s.settimeout(600)
    while True:
        c, _ = s.accept(); path = c.recv(4096).decode()
        if path == "quit": break
        c.sendall(open(path).read().encode()); c.close()
    sys.exit(0)
c = socket.socket(socket.AF_UNIX); c.connect(sys.argv[2]); c.sendall(sys.argv[3].encode()); v = c.recv(64).decode()
print("server says:", v.strip()); q = socket.socket(socket.AF_UNIX); q.connect(sys.argv[2]); q.sendall(b"quit")
sys.exit(0 if v.startswith("ok") else 1)
`

const serve = `python3 -m http.server ${port} --bind 127.0.0.1 --directory site`

/** `split` serves on a port, `daemon` on a socket; `mac` is `split` on macOS. */
const workflow = `name: ci
on: [push, pull_request]
jobs:
  split:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start the server
        run: ${serve} > /dev/null 2>&1 &
      - run: |
          for i in $(seq 1 50); do curl -sf --max-time 5 http://127.0.0.1:${port}/x.txt > got.txt && break; sleep 0.1; done
          grep -qx ok got.txt
  daemon:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          python3 tools/daemon.py serve "\${RUNNER_TEMP:-/tmp}/rec-d.sock"
          sleep 1
      - run: python3 tools/daemon.py ask "\${RUNNER_TEMP:-/tmp}/rec-d.sock" "$PWD/data/daemon.txt"
  mac:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start the server
        run: ${serve} > /dev/null 2>&1 &
      - run: curl -sf --max-time 5 http://127.0.0.1:${port}/x.txt
`

/** A repository at its first commit, beside the temporary directory, as a runner's work directory is. */
const repository = (prefix: string): { readonly base: string; readonly source: string } => {
  const base = mkdtempSync(`/var/tmp/smithers-ci-${prefix}-`)
  made.push(base)
  const source = join(base, "source")
  mkdirSync(source)
  git(source, "init", "--quiet", "--initial-branch=main")
  commit(source, "base", {
    ".github/workflows/ci.yml": workflow,
    "site/x.txt": "ok\n",
    "data/daemon.txt": "ok\n",
    "tools/daemon.py": daemon,
    "docs/notes.md": "# Notes\n"
  })
  return { base, source }
}

/** The commits after the first: one that changes nothing a job reads, one that breaks what both servers serve. */
const history = (source: string): void => {
  commit(source, "docs", { "docs/notes.md": "# Notes\n\nMore.\n" })
  commit(source, "bad", { "site/x.txt": "bad\n", "data/daemon.txt": "bad\n" })
  commit(source, "ok", { "site/x.txt": "ok\n", "data/daemon.txt": "ok\n" })
}

/** The processes of this user a job's servers would be, still running. */
const servers = (): ReadonlyArray<string> =>
  [`^${serve.replaceAll(".", "\\.")}$`, "^python3 tools/daemon\\.py serve "].flatMap((pattern) =>
    spawnSync("pgrep", ["-u", String(process.getuid?.()), "-f", pattern], { encoding: "utf8" }).stdout
      .split("\n")
      .filter((pid) => pid !== "")
  )

const left = "it left a program running for the steps after it"

describe.runIf(keeps)("a job whose step leaves a server running for the next step", () => {
  it("replays alike both ways at every commit, reuses it whole where nothing it reads changed, ends it", async () => {
    const { source } = repository("left-running-replay")
    history(source)
    const outcome = await spawn(bin, ["--commits", "3", "--no-trial", "--no-apply-check", "--json"], source)
    const report = JSON.parse(outcome.stdout) as ReplayReport
    const [docs, bad, ok] = report.commits
    expect(report.notReplayed?.map((job) => job.job)).toEqual(["ci.yml:mac"])
    expect(report.commits.map((each) => [each.baseline.ok, each.normal.ok])).toEqual([
      [true, true],
      [false, false],
      [true, true]
    ])
    const failed = (totals: NonNullable<typeof bad>["baseline"]) =>
      (totals.failures ?? []).map((each) => each.step).sort()
    expect(failed(bad!.baseline)).toEqual(["ci.yml:daemon:2", "ci.yml:split:2"])
    expect(failed(bad!.normal)).toEqual(["ci.yml:daemon:2", "ci.yml:split:2"])
    expect(report.mismatches).toBe(0)
    // What changed is a file only the servers read: they run again before the steps that ask them, which fail.
    expect(
      (bad!.normal.notReused ?? []).filter((each) => each.reason === left).map((each) => each.step).sort(),
      JSON.stringify(bad!.normal.notReused)
    ).toEqual(["ci.yml:daemon:1", "ci.yml:split: Start the server"])
    // Where the machine records what a step reads, nothing a job reads changed: nothing runs and nothing starts.
    if (observes) expect([docs!.normal.counts.ran, ok!.normal.counts.ran]).toEqual([0, 0])
    expect(servers()).toEqual([])
  }, 900_000)

  it("passes and fails in the CI `apply` writes as on a runner, and ends the servers with their jobs", async () => {
    const { base, source } = repository("left-running-applied")
    const applied = await spawn(bin, ["apply"], source)
    expect(applied.code, applied.stderr).toBe(0)
    commit(source, "apply")
    const shas: Array<string> = []
    for (
      const [subject, files] of [
        ["docs", { "docs/notes.md": "# Notes\n\nMore.\n" }],
        ["bad", { "site/x.txt": "bad\n", "data/daemon.txt": "bad\n" }],
        ["ok", { "site/x.txt": "ok\n", "data/daemon.txt": "ok\n" }]
      ] as const
    ) {
      commit(source, subject, files)
      shas.push(head(source))
    }
    const state = join(base, "state", "smithers-ci")
    // A runner's home is short, at the same place at every run and empty: a socket under a job's directory fits.
    const home = mkdtempSync("/tmp/smithers-ci-home-")
    made.push(home)
    const run = (sha: string, at: number) => {
      const checkout = join(base, "run")
      remove(home)
      mkdirSync(home)
      remove(checkout)
      git(base, "clone", "--quiet", source, checkout)
      git(checkout, "checkout", "--quiet", "-B", "main", sha)
      const results = join(base, `results-${at}.json`)
      const ran = spawnSync(
        process.execPath,
        [smthrs, "ci", "//...", "--ui", "plain", "--results-file", results, "--cache-dir", state],
        {
          cwd: checkout,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            HOME: home,
            CI: "true",
            GITHUB_ACTIONS: "true",
            GITHUB_SHA: sha,
            GITHUB_REF: "refs/heads/main",
            GITHUB_REF_NAME: "main",
            GITHUB_EVENT_NAME: "push",
            GITHUB_RUN_ID: String(7_000 + at),
            GITHUB_RUN_NUMBER: String(at),
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_REPOSITORY: "example/left-running",
            GITHUB_WORKSPACE: checkout,
            RUNNER_TEMP: join(base, "runner-temp"),
            RUNNER_OS: "Linux",
            NODE_COMPILE_CACHE: join(state, compiledCode),
            SMTHRS_MACHINE_OWN_TMP: "required"
          }
        }
      )
      const record = JSON.parse(readFileSync(results, "utf8")) as {
        readonly results: ReadonlyArray<
          { readonly label: string; readonly status: string; readonly notReused?: string }
        >
      }
      return {
        code: ran.status,
        statuses: Object.fromEntries(record.results.map((each) => [each.label, each.status])),
        // Why a step that ran was not answered by an earlier result, as Smithers build says it.
        notReused: record.results.flatMap((each) =>
          each.notReused === undefined ? [] : [`${each.label}: ${each.notReused}`]
        )
      }
    }
    const [docs, bad, ok] = shas
    const first = run(docs!, 1)
    expect(first.code).toBe(0)
    expect(servers()).toEqual([])
    const second = run(bad!, 2)
    expect(second.code).toBe(1)
    expect(second.statuses).toMatchObject({
      "//:ci.yml-split-1": "ran",
      "//:ci.yml-split-2": "failed",
      "//:ci.yml-daemon-1": "ran",
      "//:ci.yml-daemon-2": "failed"
    })
    expect(servers()).toEqual([])
    const third = run(ok!, 3)
    expect(third.code).toBe(0)
    // Back to what the first run read: every step is answered by it, and no server starts.
    if (observes) {
      expect(third.statuses, third.notReused.join("\n")).toMatchObject({
        "//:ci.yml-split-1": "hit",
        "//:ci.yml-split-2": "hit",
        "//:ci.yml-daemon-1": "hit",
        "//:ci.yml-daemon-2": "hit"
      })
    }
    expect(servers()).toEqual([])
  }, 900_000)
})

describe("apply, with jobs whose step leaves a server running for the next step", () => {
  it(
    "writes the jobs on Linux as build steps, and keeps the one on macOS out, named in the notes with why",
    async () => {
      const { source } = repository("left-running-notes")
      const applied = await spawn(bin, ["apply"], source)
      expect(applied.code, applied.stderr).toBe(0)
      const declared = readFileSync(join(source, workspacePath), "utf8")
      expect(declared).toContain("ci.yml-split-2")
      expect(declared).toContain("ci.yml-daemon-2")
      expect(declared).not.toContain("ci.yml-mac")
      const notes = readFileSync(join(source, notesPath), "utf8")
      expect(notes).toContain(
        "- ci.yml:mac: not in this workflow: leaves a program running for its later steps, which this machine " +
          "cannot keep until the job ends: \"Start the server\" leaves python3 running; the job stays in your CI as it is\n"
      )
      expect(notes).not.toContain("ci.yml:split: not in this workflow")
      // The repository's own workflow is as it was: the job on macOS runs there.
      expect(git(source, "status", "--porcelain", "--", ".github/workflows/ci.yml")).toBe("")
    },
    180_000
  )
})
