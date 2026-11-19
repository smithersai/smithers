/**
 * The real `smithers-ci`, started as a process in real repositories, on a machine whose `docker` is a program the
 * test puts first on `PATH`. That `docker` passes whatever it is asked, so a step that reaches it passes, and a step
 * that finds the replay's stand-in in its place fails. A replay never starts it unless it is told `--allow-docker`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const directory = (name: string): string => {
  const path = temporary(name)
  made.push(path)
  return path
}

const repository = (files: Readonly<Record<string, string>>): string => {
  const root = directory("no-docker")
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

/** A machine with a `docker` that logs every call where it can write, and passes. */
const machine = () => {
  const tools = directory("no-docker-tools")
  const log = join(tools, "calls.log")
  mkdirSync(tools, { recursive: true })
  writeFileSync(join(tools, "docker"), `#!/bin/sh\n(echo "docker $*" >> ${log}) 2>/dev/null\nexit 0\n`)
  chmodSync(join(tools, "docker"), 0o755)
  return { log, env: { ...process.env, PATH: `${tools}:${process.env["PATH"]}` } }
}

const replay = async (root: string, env: NodeJS.ProcessEnv, ...flags: ReadonlyArray<string>) => {
  const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check", "--json", ...flags], root, env)
  expect(outcome.code, outcome.stderr).toBe(0)
  return JSON.parse(outcome.stdout) as ReplayReport
}

describe.concurrent("a replay on a machine with docker", () => {
  it("does not replay a job that runs docker, and never starts it", async () => {
    const { env, log } = machine()
    const root = repository({
      ".github/workflows/ci.yml": workflow(["docker compose up -d", "sh build.sh"]),
      "build.sh": "exit 0\n",
      "test.sh": "exit 0\n"
    })
    const report = await replay(root, env)
    expect(report.notReplayed).toEqual([{
      job: "ci.yml:build",
      reasons: [{ feature: "docker", detail: "runs docker compose" }]
    }])
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.commits[0]?.mismatches).toEqual([])
    expect(existsSync(log)).toBe(false)
  }, replayLimit)

  it("fails a step whose script runs docker inside, the same way in the baseline and as a target", async () => {
    const { env, log } = machine()
    const root = repository({
      ".github/workflows/ci.yml": workflow(["sh build.sh"]),
      // The reader sees `sh build.sh`; what the script starts, only the run shows.
      "build.sh": "docker info\n",
      "test.sh": "exit 0\n"
    })
    // The failing step is what this test reads, so it is measured and not left out.
    const report = await replay(root, env, "--no-trial")
    expect(report.notReplayed ?? []).toEqual([])
    // The machine's docker passes, so the step failed on the stand-in that stood in its place.
    const counts = { hit: 0, ran: 1, failed: 1, skipped: 0 }
    expect(report.commits[0]?.baseline.counts).toEqual(counts)
    expect(report.commits[0]?.normal.counts).toEqual(counts)
    expect(report.commits[0]?.mismatches).toEqual([])
    // The report says why, with the one line the stand-in printed.
    const said = { reason: "smithers-ci does not run docker without --allow-docker: info", exitCode: 1 }
    expect(report.commits[0]?.baseline.failures).toEqual([expect.objectContaining(said)])
    expect(report.commits[0]?.normal.failures).toEqual([expect.objectContaining(said)])
    expect(existsSync(log)).toBe(false)
  }, replayLimit)

  it("replays the job with --allow-docker, and its steps start the machine's docker", async () => {
    const { env } = machine()
    const root = repository({
      ".github/workflows/ci.yml": workflow(["docker compose up -d", "sh build.sh"]),
      "build.sh": "docker info\n",
      "test.sh": "exit 0\n"
    })
    const report = await replay(root, env, "--allow-docker")
    expect(report.notReplayed ?? []).toEqual([])
    // Every step passed: the two that start docker reached the machine's own, in the baseline and as targets.
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(report.commits[0]?.mismatches).toEqual([])
  }, replayLimit)

  it("writes no target for a job that runs docker unless apply is told --allow-docker", async () => {
    const { env } = machine()
    const root = repository({
      ".github/workflows/ci.yml": `
on: push
jobs:
  image:
    runs-on: ${runner}
    steps:
      - run: docker build -t app .
`
    })
    const refused = await spawn(bin, ["apply"], root, env)
    expect(refused.code).toBe(3)
    expect(refused.stderr).toContain(
      "runs docker, and a container daemon can reach every file of this machine; pass --allow-docker to replay it"
    )
    const applied = await spawn(bin, ["apply", "--allow-docker"], root, env)
    expect(applied.code).toBe(0)
    expect(applied.stdout).toContain("smithers-ci: wrote")
    expect(existsSync(join(root, ".smithers", "WORKSPACE.smithers"))).toBe(true)
    // The workflow checks its files as they were written: with the flag, they are up to date.
    const workflow = readFileSync(join(root, ".github", "workflows", "smithers-ci.yml"), "utf8")
    const steps = (parseYaml(workflow) as {
      readonly jobs: {
        readonly ci: { readonly steps: ReadonlyArray<{ readonly name?: string; readonly run?: string }> }
      }
    }).jobs.ci.steps
    expect(steps.find((one) => one.name === "Generated files are up to date")?.run).toMatch(
      / smithers-ci apply --check --allow-docker$/
    )
    expect((await spawn(bin, ["apply", "--check", "--allow-docker"], root, env)).code).toBe(0)
    expect((await spawn(bin, ["apply", "--check"], root, env)).code).toBe(3)
  }, replayLimit)
})
