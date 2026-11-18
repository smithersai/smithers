/**
 * The real `smithers-ci`, started as a process in a real repository whose CI this machine cannot run. Nothing is
 * measured, so the answer has to say why in words a person can act on.
 */

import { afterAll, describe, expect, it } from "vitest"
import { bin, commit, git, remove, spawn, temporary } from "../cli/repo.ts"

const made: Array<string> = []
afterAll(() => made.forEach(remove))

const repository = (workflow: string): string => {
  const root = temporary("first-run")
  made.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  commit(root, "ci", { ".github/workflows/main.yml": workflow, "package.json": "{}\n" })
  return root
}

const tests = (runsOn: string, extra = "") => `
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@v6
${extra}
      - run: npm install
      - run: npm test
`

/** A system this machine is not, as a runner names it and as a person does, and where to run instead. */
const other = process.platform === "darwin"
  ? { runner: "ubuntu-latest", line: "runs on Linux; run smithers-ci on Linux" }
  : { runner: "macos-latest", line: "runs on macOS; run smithers-ci on a Mac" }

describe.concurrent("a first run that cannot measure anything", () => {
  it("says in one line that every CI job runs on another system, and exits 3", async () => {
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check"], repository(tests(other.runner)))
    expect(outcome).toEqual({
      code: 3,
      stdout: "",
      stderr: `smithers-ci: replay: every CI job of this repository ${other.line}\n`
    })
  })

  it("says the same of a repository whose CI runs only on Windows", async () => {
    const root = repository(tests("windows-latest"))
    const line = "every CI job of this repository runs on Windows; smithers-ci runs on Linux and macOS\n"
    expect(await spawn(bin, ["--commits", "1", "--no-apply-check"], root)).toEqual({
      code: 3,
      stdout: "",
      stderr: `smithers-ci: inventory: ${line}`
    })
    expect((await spawn(bin, ["replay", "--commits", "1", "--no-apply-check"], root)).stderr).toBe(
      `smithers-ci: replay: ${line}`
    )
  })

  it("names the tool to install when the one job needs a tool this machine lacks, and exits 3", async () => {
    const setup = "      - uses: acme/setup-no-such-tool-of-smithers-ci@v2\n        with: { version: 9.1 }"
    const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"
    const outcome = await spawn(bin, ["--commits", "1", "--no-apply-check"], repository(tests(runner, setup)))
    expect(outcome).toEqual({
      code: 3,
      stdout: "",
      stderr: [
        "smithers-ci: replay: 0 of 1 CI job can be reproduced on this machine",
        "  main.yml:test  needs no-such-tool-of-smithers-ci 9.1, which this machine does not have; install it and run smithers-ci again",
        ""
      ].join("\n")
    })
  })
})
