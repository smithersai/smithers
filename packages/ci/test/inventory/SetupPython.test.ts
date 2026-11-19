/**
 * A job that sets Python up finds `python` and `pip` on its PATH after that step, as the action leaves them on a
 * runner, on a machine that has only `python3`. Real workflows, run as the baseline and a target run them.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Job } from "../../src/contract/Inventory.ts"
import { jobsOf, type Repository, repository, runJob } from "./run.ts"

const file = ".github/workflows/ci.yml"
const made: Array<string> = []
const repositories: Array<Repository> = []

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.remove()
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** The machine's own Python 3, as a program on the PATH this test was started with. */
const python3 = (): string => {
  const found = spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim()
  if (found === "") throw new Error("this test needs python3 on the PATH")
  return realpathSync(found)
}

/**
 * A machine with every program of this one's PATH but `python` and `pip` of any version, and with `python3`: a
 * directory of links, the PATH a step runs with.
 */
const onlyPython3 = (): string => {
  const machine = mkdtempSync(join(tmpdir(), "smithers-ci-machine-"))
  made.push(machine)
  const taken = new Set<string>()
  for (const directory of (process.env["PATH"] ?? "").split(":")) {
    if (directory === "" || !existsSync(directory) || !statSync(directory).isDirectory()) continue
    for (const name of readdirSync(directory)) {
      if (/^(?:python|pip)/.test(name) || taken.has(name)) continue
      taken.add(name)
      symlinkSync(join(directory, name), join(machine, name))
    }
  }
  symlinkSync(python3(), join(machine, "python3"))
  return machine
}

const workflow = (steps: string): string => `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${steps}`

const jobOf = (repo: Repository): Job => {
  const job = jobsOf(repo, file).find((candidate) => candidate.id === "ci.yml:build")
  if (job === undefined) throw new Error("no job ci.yml:build")
  return job
}

/** What each step of the workflow printed, run as the baseline runs it on a machine with only `python3`. */
const run = (steps: string): ReadonlyArray<string> => {
  const repo = repository({ [file]: workflow(steps) })
  repositories.push(repo)
  const ran = runJob(repo, jobOf(repo), {}, onlyPython3())
  for (const step of ran) expect(step.status, step.output).toBe(0)
  return ran.map((step) => step.output.trim())
}

describe("a job that sets Python up", () => {
  it("finds python, python3, pip and pip3 after that step, each running the machine's Python 3", () => {
    const [before, found, version, pip, same] = run(`
      - run: command -v python || echo none
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: |
          for p in python python3 pip pip3; do printf '%s ' "$(command -v $p)"; done
          printf '%s' "$RUNNER_TOOL_CACHE"
      - run: python -c 'import sys; print(sys.version_info[0])'
      - run: pip --version 2>&1 || true
      - run: python3 -m pip --version 2>&1 || true
`)
    expect(before).toBe("none")
    const [pythonAt, python3At, pipAt, pip3At, tools] = (found as string).split(" ") as [
      string,
      string,
      string,
      string,
      string
    ]
    // Every one is in the job's own tool directory, and none anywhere else.
    for (const program of [pythonAt, python3At, pipAt, pip3At]) {
      expect(program.startsWith(`${tools}/`), program).toBe(true)
    }
    expect(realpathSync(pythonAt)).toBe(python3())
    expect(realpathSync(python3At)).toBe(python3())
    expect(version).toBe("3")
    // pip is the machine's Python's own pip, whether that has one or not; each names the program it was run as.
    const named = (text: string | undefined): string => (text ?? "").replace(/\S*\/(?=python)/g, "")
    expect(named(pip)).toBe(named(same))
    expect(named(pip)).toMatch(/python ?3/)
  })

  it("gives the steps of a job that sets no Python up nothing", () => {
    const [found] = run(`
      - run: command -v python || echo none
`)
    expect(found).toBe("none")
  })

  it("gives no python to a job whose setup action sets up another tool with Python beside it", () => {
    const [found] = run(`
      - uses: astral-sh/setup-uv@v5
        with:
          python-version: "3.12"
      - run: command -v python || echo none
`)
    expect(found).toBe("none")
  })

  it("stops a step with one line when the machine has no Python at all", () => {
    const repo = repository({
      [file]: workflow(`
      - uses: actions/setup-python@v5
      - run: python --version
`)
    })
    repositories.push(repo)
    const machine = onlyPython3()
    rmSync(join(machine, "python3"))
    const ran = runJob(repo, jobOf(repo), {}, machine)
    expect(ran.at(-1)?.status).toBe(1)
    expect(ran.at(-1)?.output).toContain("smithers-ci: this job sets up Python, and this machine has none")
  })
})
