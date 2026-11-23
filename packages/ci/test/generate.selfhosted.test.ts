/**
 * The workflow `apply` writes changes a machine only where GitHub made it for the job: on a self-hosted runner it
 * installs nothing and lowers no setting, and the job stops with one line where bubblewrap cannot start.
 */
import * as Effect from "effect/Effect"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { Ci, Inventory as InventoryDocument, Job, Step } from "../src/contract/Inventory.vibe"
import { files } from "../src/generate/index.vibe"
import { selfHostedCheck, workflowPath } from "../src/generate/Render.ts"

const made: Array<string> = []
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

const step = (id: string, command: string, extra: Partial<Step> = {}): Step => ({
  id,
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

const job = (id: string, steps: ReadonlyArray<Step>): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  steps,
  unsupported: []
})

const inventory = (jobs: ReadonlyArray<Job>): InventoryDocument => ({
  version: 1,
  repository: "example/repo",
  commit: "0000000000000000000000000000000000000003",
  toolchains: [],
  jobs
})

interface WorkflowStep {
  readonly name?: string
  readonly if?: string
  readonly run?: string
}

/** The steps of the workflow generated for `document`. */
const stepsOf = (document: InventoryDocument, cache?: string): ReadonlyArray<WorkflowStep> => {
  const generated = Effect.runSync(files(document as Ci, cache === undefined ? undefined : { cache }))
  const workflow = generated.find((file) => file.path === workflowPath)?.content ?? ""
  return (parseYaml(workflow) as { jobs: { ci: { steps: ReadonlyArray<WorkflowStep> } } }).jobs.ci.steps
}

const hosted = "runner.environment == 'github-hosted'"
const selfHosted = "runner.environment != 'github-hosted'"

/** Workflows with each step that sets bubblewrap up: a held target, a job's own /tmp with a cache, and a cache alone. */
const workflows = (): ReadonlyArray<readonly [string, ReadonlyArray<WorkflowStep>]> => [
  [
    "a target held to its inputs",
    stepsOf(inventory([job("a", [step("a:1", "x", { inputs: ["src/**"], from: "a:1" })])]))
  ],
  [
    "two jobs with a /tmp of their own and a cache",
    stepsOf(
      inventory([job("a", [step("a:1", "x"), step("a:2", "y")]), job("b", [step("b:1", "z")])]),
      "https://c.example"
    )
  ],
  [
    "one recipe and a cache",
    stepsOf(
      inventory([{ ...job("a", [step("a:1", "x")]), source: "justfile", file: "Justfile" }]),
      "https://c.example"
    )
  ]
]

describe("the workflow on a self-hosted runner", () => {
  it.each(workflows())("changes nothing on the machine, for %s", (_, steps) => {
    const changing = steps.filter((entry) => /\bsudo\b/.test(entry.run ?? ""))
    expect(changing.length).toBeGreaterThan(0)
    // Every step that installs or lowers a setting runs on a runner GitHub made for the job, and only there.
    for (const entry of changing) expect(entry.if, entry.name).toContain(hosted)
    expect(
      steps.some((entry) => (entry.run ?? "").includes("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0"))
    )
      .toBe(true)
  })

  it.each(workflows())("checks bubblewrap in place of each step that sets it up, for %s", (_, steps) => {
    const setting = steps.filter((entry) => (entry.run ?? "").includes("bubblewrap") && entry.if?.includes(hosted))
    expect(setting.length).toBeGreaterThan(0)
    for (const entry of setting) {
      const check = steps.find((other) => other.name === `${entry.name} on a self-hosted runner`)
      expect(check?.if).toBe((entry.if as string).replace(hosted, selfHosted))
      expect(check?.run).not.toMatch(/\bsudo\b/)
    }
  })
})

/** Runs the check a self-hosted runner gets, with `programs` as the only programs on its PATH. */
const check = (programs: Readonly<Record<string, string>>) => {
  const bin = mkdtempSync(join(tmpdir(), "smithers-ci-runner-bin-"))
  made.push(bin)
  for (const [name, text] of Object.entries(programs)) {
    writeFileSync(join(bin, name), text)
    chmodSync(join(bin, name), 0o755)
  }
  const ran = spawnSync("/bin/bash", ["-e", "-c", selfHostedCheck("it gives each job a /tmp of its own")], {
    env: { PATH: bin },
    encoding: "utf8"
  })
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

const realBwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0

describe("the check on a self-hosted runner", () => {
  it("stops with one line that says to install bubblewrap where there is none", () => {
    const ran = check({})
    expect(ran.status).toBe(1)
    expect(ran.stdout).toBe("")
    expect(ran.stderr).toBe(
      "::error::smithers-ci: install bubblewrap (bwrap) on this self-hosted runner: it gives each job a /tmp of its own.\n"
    )
  })

  it("stops with one line that names the setting to change, and why, where bubblewrap cannot start", () => {
    const ran = check({ bwrap: "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n" })
    expect(ran.status).toBe(1)
    expect(ran.stdout).toBe("")
    expect(ran.stderr).toBe(
      "::error::smithers-ci: set kernel.apparmor_restrict_unprivileged_userns=0 on this self-hosted runner, " +
        "or otherwise allow unprivileged user namespaces: bubblewrap needs one to start, and it gives each job a " +
        "/tmp of its own.\n"
    )
  })

  it("passes, saying nothing, where bubblewrap starts", () => {
    const ran = check({ bwrap: "#!/bin/sh\nexit 0\n" })
    expect(ran).toEqual({ status: 0, stdout: "", stderr: "" })
  })

  it.runIf(realBwrap)("passes with this machine's own bubblewrap", () => {
    const ran = spawnSync("bash", ["-e", "-c", selfHostedCheck("why")], { encoding: "utf8" })
    expect(ran.status, ran.stderr).toBe(0)
  })
})
