/**
 * The real `smithers-ci`, started as a process in real repositories, on a machine whose `sudo` and package manager
 * are programs the test puts first on `PATH`. A replay never runs the one, and only asks the other what it has.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const directory = (name: string): string => {
  const path = temporary(name)
  made.push(path)
  return path
}

const repository = (files: Readonly<Record<string, string>>): string => {
  const root = directory("no-sudo")
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "ci", files)
  return root
}

/** A real replay runs each commit up to three ways, and a failed step again; a busy machine takes minutes. */
const replayLimit = 540_000

const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"

const workflow = (build: ReadonlyArray<string>): string => `
on: push
jobs:
  build:
    runs-on: ${runner}
    steps:
${build.map((command) => `      - run: ${command}`).join("\n")}
  test:
    runs-on: ${runner}
    steps:
      - run: sh test.sh
`

/** A machine: `sudo` and `apt-get` that log every call, and `dpkg` that has only the packages given. */
const machine = (installed: ReadonlyArray<string>) => {
  const tools = directory("no-sudo-tools")
  const log = join(tools, "calls.log")
  const write = (name: string, script: string) => {
    mkdirSync(tools, { recursive: true })
    writeFileSync(join(tools, name), `#!/bin/sh\n${script}\n`)
    chmodSync(join(tools, name), 0o755)
  }
  write("sudo", `echo "sudo $*" >> ${log}\nexit 0`)
  write("apt-get", `echo "apt-get $*" >> ${log}\nexit 0`)
  const known = installed.map((name) => `${name}) printf 'Status: install ok installed\\nVersion: 1\\n' ;;`).join("\n")
  write("dpkg", `case "$2" in\n${known}\n*) exit 1 ;;\nesac`)
  return { log, env: { ...process.env, PATH: `${tools}:${process.env["PATH"]}` } }
}

const replay = async (root: string, env: NodeJS.ProcessEnv, flags: ReadonlyArray<string> = []) => {
  const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--json", ...flags], root, env)
  expect(outcome.stderr).not.toContain("error")
  expect(outcome.code).toBe(0)
  return JSON.parse(outcome.stdout) as ReplayReport
}

describe.concurrent("a replay on a machine with sudo", () => {
  it("does not replay a job that installs a missing package, and never starts sudo", async () => {
    const { env, log } = machine(["zsh"])
    const root = repository({
      ".github/workflows/ci.yml": workflow(["sudo apt-get install -y zsh fish", "sh build.sh"]),
      "build.sh": "exit 0\n",
      "test.sh": "exit 0\n"
    })
    const report = await replay(root, env)
    expect(report.notReplayed).toEqual([{
      job: "ci.yml:build",
      reasons: [{ feature: "changes-machine", detail: "install fish with apt-get to replay this job" }]
    }])
    expect(report.commits[0]?.mismatches).toEqual([])
    expect(existsSync(log)).toBe(false)
  }, replayLimit)

  it("replays a job whose packages are all there, without the install", async () => {
    const { env, log } = machine(["zsh", "fish"])
    const root = repository({
      ".github/workflows/ci.yml": workflow(["sudo apt-get update", "sudo apt-get install -y zsh fish", "sh build.sh"]),
      "build.sh": "exit 0\n",
      "test.sh": "exit 0\n"
    })
    const report = await replay(root, env)
    expect(report.notReplayed ?? []).toEqual([])
    expect(report.commits[0]?.baseline.ok).toBe(true)
    expect(report.commits[0]?.normal.ok).toBe(true)
    expect(report.commits[0]?.mismatches).toEqual([])
    // `build.sh` and `test.sh` ran; the two steps that install did not.
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(existsSync(log)).toBe(false)
  }, replayLimit)

  it("stops a script that calls sudo with the same failure in the baseline and as a target", async () => {
    const { env, log } = machine([])
    const root = repository({
      ".github/workflows/ci.yml": `
on: push
jobs:
  refused:
    runs-on: ${runner}
    steps:
      - run: sh refused.sh
  told:
    runs-on: ${runner}
    steps:
      - run: sh told.sh
`,
      "refused.sh": "sudo apt-get update\n",
      // It passes only when what it started printed the stand-in's line and failed.
      "told.sh": [
        "out=$(sudo apt-get install zsh 2>&1) && exit 1",
        "[ \"$out\" = \"smithers-ci does not run sudo: apt-get install zsh\" ]",
        ""
      ].join("\n")
    })
    // A job that fails is measured here, not left out: the failure itself is what this test reads.
    const report = await replay(root, env, ["--no-trial"])
    const commit = report.commits[0]
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 1, skipped: 0 })
    expect(commit?.normal.counts).toEqual({ hit: 0, ran: 1, failed: 1, skipped: 0 })
    expect(commit?.mismatches).toEqual([])
    expect(report.notReplayed ?? []).toEqual([])
    expect(existsSync(log)).toBe(false)
  }, replayLimit)

  it("replays a job whose step asks before it uses sudo, and takes the path of a machine with none", async () => {
    const { env, log } = machine([])
    const root = repository({
      ".github/workflows/ci.yml": `
on: push
jobs:
  build:
    runs-on: ${runner}
    steps:
      - run: |
          if ! command -v sudo >/dev/null 2>&1 || ! sudo -n true 2>/dev/null; then
            echo "no sudo here"
            exit 0
          fi
          sudo tee /etc/smithers-ci-no-sudo-test < /dev/null
          exit 1
`
    })
    const report = await replay(root, env)
    expect(report.notReplayed ?? []).toEqual([])
    const commit = report.commits[0]
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(commit?.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(commit?.mismatches).toEqual([])
    // The machine's own `sudo` was never started: the question went to the stand-in, which refused.
    expect(existsSync(log)).toBe(false)
  }, replayLimit)

  it("replays when every job installs what is there, and says apply has nothing to write", async () => {
    const { env, log } = machine(["zsh"])
    const root = repository({
      ".github/workflows/ci.yml": `
on: push
jobs:
  build:
    runs-on: ${runner}
    steps:
      - run: sudo apt-get install -y zsh
      - run: sh build.sh
`,
      "build.sh": "exit 0\n"
    })
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check"], root, env)
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain("smithers-ci apply would write nothing")
    expect(existsSync(log)).toBe(false)
    const applied = await spawn(bin, ["apply"], root, env)
    expect(applied.code).toBe(3)
    expect(applied.stderr).toContain("changes the machine it runs on: installs zsh with apt-get")
  }, replayLimit)
})
