/**
 * A target runs on the runner its job names, not on every runner of that runner's system (round 1, Fable P1 #9,
 * Astra P1 #22), and a pull request is never given the cache's write token (Astra P1 #5).
 */
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import type { Ci, Inventory as InventoryDocument, Job, Step } from "../src/contract/Inventory.vibe"
import type { GeneratedFile } from "../src/contract/Parts.vibe"
import { forShell, forText } from "../src/generate/Expressions.vibe"
import { files } from "../src/generate/index.vibe"
import { legsPath, notesPath, workflowPath, workspacePath } from "../src/generate/Render.ts"
import { exactRunners, planSteps, type StepPlan } from "../src/generate/Steps.vibe"

const step = (id: string, command: string, extra: Partial<Step> = {}): Step => ({
  id,
  command,
  cwd: "",
  env: {},
  secrets: [],
  ...extra
})

const job = (id: string, runsOn: string | undefined, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  steps: [step(`${id}:1`, `make ${id}`)],
  unsupported: [],
  ...(runsOn === undefined ? {} : { runsOn }),
  ...extra
})

const inventory = (jobs: ReadonlyArray<Job>): Ci => {
  const document: InventoryDocument = {
    version: 1,
    repository: "example/repo",
    commit: "0000000000000000000000000000000000000003",
    toolchains: [],
    jobs
  }
  return document as Ci
}

const planned = (jobs: ReadonlyArray<Job>): StepPlan => {
  const plan = planSteps(inventory(jobs))
  if (Result.isFailure(plan)) throw new Error(plan.failure.message)
  return plan.success
}

const generate = (jobs: ReadonlyArray<Job>): ReadonlyArray<GeneratedFile> => Effect.runSync(files(inventory(jobs)))

const content = (generated: ReadonlyArray<GeneratedFile>, path: string): string =>
  generated.find((file) => file.path === path)?.content ?? ""

/** Which runner runs which targets: each leg's runner with its labels. */
const legsOf = (plan: StepPlan): ReadonlyArray<readonly [string, ReadonlyArray<string>]> =>
  plan.legs.map((leg) => [leg.runner, [...leg.labels].sort()] as const)

describe("the runners whose targets run on them alone", () => {
  it("are none while each system has one runner", () => {
    expect([...exactRunners([])]).toEqual([])
    expect([...exactRunners(["ubuntu-latest"])]).toEqual([])
    expect([...exactRunners(["ubuntu-latest", "ubuntu-latest", "macos-latest"])]).toEqual([])
  })

  it("are the runners that share a system, and every runner once a label names no system", () => {
    expect([...exactRunners(["ubuntu-22.04", "macos-latest", "ubuntu-24.04"])].sort()).toEqual([
      "ubuntu-22.04",
      "ubuntu-24.04"
    ])
    expect([...exactRunners(["ubuntu-latest", "self-hosted,linux,gpu"])].sort()).toEqual([
      "self-hosted,linux,gpu",
      "ubuntu-latest"
    ])
    expect([...exactRunners(["self-hosted", "macos-latest"])].sort()).toEqual(["macos-latest", "self-hosted"])
  })
})

describe("a target of a job that names its runner", () => {
  it("runs on that runner alone when two runners are of one system", () => {
    const plan = planned([job("old", "ubuntu-22.04"), job("new", "ubuntu-24.04")])
    expect(plan.runners).toEqual(["ubuntu-22.04", "ubuntu-24.04"])
    // Each label is in exactly one leg: neither runner runs the other's job.
    expect(legsOf(plan)).toEqual([["ubuntu-22.04", ["old-1"]], ["ubuntu-24.04", ["new-1"]]])
    const generated = generate([job("old", "ubuntu-22.04"), job("new", "ubuntu-24.04")])
    expect(content(generated, legsPath).split("\n").slice(1, -1)).toEqual(["1 //:old-1", "2 //:new-1"])
    const matrix = (parseYaml(content(generated, workflowPath)) as {
      readonly jobs: { readonly ci: { readonly strategy: { readonly matrix: { readonly include: unknown } } } }
    }).jobs.ci.strategy.matrix.include
    expect(matrix).toEqual([
      { os: "ubuntu-22.04", leg: 1, tools: "runner ubuntu-22.04" },
      { os: "ubuntu-24.04", leg: 2, tools: "runner ubuntu-24.04" }
    ])
    // The runner is part of what a target runs under, so of its key: a result of one runner is not the other's.
    expect(content(generated, workspacePath)).toContain("# Runs under runner ubuntu-22.04.")
  })

  it("runs once for each runner of a matrix of runners, never once for each pair", () => {
    const matrix = job("test", "${{ matrix.os }}", { matrix: [{ os: "ubuntu-22.04" }, { os: "ubuntu-24.04" }] })
    const plan = planned([matrix])
    expect(legsOf(plan)).toEqual([
      ["ubuntu-22.04", ["test-1--ubuntu-22.04"]],
      ["ubuntu-24.04", ["test-1--ubuntu-24.04"]]
    ])
  })

  it("keeps a hosted job off a self-hosted runner of the same system, and that runner's job off the hosted one", () => {
    const plan = planned([job("hosted", "ubuntu-latest"), job("gpu", "self-hosted,linux,gpu")])
    expect(legsOf(plan)).toEqual([["self-hosted,linux,gpu", ["gpu-1"]], ["ubuntu-latest", ["hosted-1"]]])
  })

  it("keeps a runner whose label names no system to its own job, and every other job off it", () => {
    const plan = planned([job("own", "self-hosted"), job("mac", "macos-latest"), job("linux", "ubuntu-latest")])
    expect(legsOf(plan)).toEqual([
      ["macos-latest", ["mac-1"]],
      ["self-hosted", ["own-1"]],
      ["ubuntu-latest", ["linux-1"]]
    ])
  })

  it("still runs a job that names no runner on every runner, and one runner of each system needs no leg", () => {
    // A recipe of a Justfile names no runner: it runs beside each runner's own job.
    const recipe = job("recipe", undefined, { source: "justfile", file: "Justfile" })
    const plan = planned([job("old", "ubuntu-22.04"), job("new", "ubuntu-24.04"), recipe])
    expect(legsOf(plan)).toEqual([
      ["ubuntu-22.04", ["recipe-1"]],
      ["ubuntu-22.04", ["old-1"]],
      ["ubuntu-24.04", ["recipe-1"]],
      ["ubuntu-24.04", ["new-1"]]
    ])
    // One Linux runner and one macOS runner: the system alone picks the runner, as before.
    const apart = planned([job("linux", "ubuntu-latest"), job("mac", "macos-latest")])
    expect(apart.runners).toEqual(["macos-latest", "ubuntu-latest"])
    expect(apart.targets.map((target) => [target.label, target.host])).toEqual([["linux-1", "linux"], [
      "mac-1",
      "darwin"
    ]])
  })

  it("does not wait for a job on another runner of its system, and the notes say so", () => {
    const generated = generate([job("build", "ubuntu-22.04"), job("test", "ubuntu-24.04", { needs: ["build"] })])
    expect(content(generated, notesPath)).toContain(
      "test: runs with runner ubuntu-24.04, so it does not wait for build, which runs with runner ubuntu-22.04."
    )
  })

  it("leaves a variant whose runner the workflow does not give, and a Windows runner, out of the count", () => {
    const unknown = job("picked", "${{ inputs.runner }}")
    const windows = job("win", "windows-latest")
    const plan = planned([job("linux", "ubuntu-latest"), unknown, windows])
    // One runner runs targets, so no target is held to a runner and the workflow has no leg.
    expect(plan.legs).toEqual([])
    expect(plan.runners).toEqual(["ubuntu-latest"])
  })
})

describe("an expression written over several lines", () => {
  it("is read as the expression it is: filled in when it names a matrix value, and never left as text", () => {
    expect(forShell("echo ${{\n  matrix.os\n}}", { os: "linux" })).toBe("echo linux")
    expect(forText("${{\n  matrix.os\n}}/bin", { os: "linux" })).toBe("linux/bin")
    // One only GitHub Actions can fill in has no form here, whatever lines it is written on.
    expect(forShell("echo ${{ format('{0}',\n  matrix.os) }}", { os: "linux" })).toBeUndefined()
    expect(forText("${{ format('{0}',\n  matrix.os) }}", { os: "linux" })).toBeUndefined()
  })
})

describe("the cache's token in the workflow", () => {
  /** GitHub's value for the token's expression: `&&` and `||` give one of their operands, an unset secret is empty. */
  const tokenFor = (
    event: string,
    secrets: { readonly read?: string; readonly write?: string },
    branch: "default" | "other" = "default",
    refType: "branch" | "tag" = "branch"
  ): string => {
    const workflow = parseYaml(content(generate([job("a", "ubuntu-latest")]), workflowPath)) as {
      readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<{ readonly env?: Record<string, string> }> } }
    }
    const expression = workflow.jobs.ci.steps.find((entry) => entry.env?.["SMITHERS_CACHE_TOKEN"] !== undefined)
      ?.env?.["SMITHERS_CACHE_TOKEN"] as string
    const value = (term: string): string | boolean => {
      const compared = /^github\.event_name (==|!=) '([^']*)'$/.exec(term)
      if (compared !== null) return (event === compared[2]) === (compared[1] === "==")
      const type = /^github\.ref_type (==|!=) 'branch'$/.exec(term)
      if (type !== null) return (refType === "branch") === (type[1] === "==")
      const onBranch = /^github\.ref_name (==|!=) github\.event\.repository\.default_branch$/.exec(term)
      // A pull request's ref is its merge commit's, never the default branch.
      if (onBranch !== null) return (event !== "pull_request" && branch === "default") === (onBranch[1] === "==")
      if (term === "secrets.SMITHERS_CACHE_READ_TOKEN") return secrets.read ?? ""
      if (term === "secrets.SMITHERS_CACHE_TOKEN") return secrets.write ?? ""
      expect(term).toBe("''")
      return ""
    }
    const truthy = (given: string | boolean): boolean => given !== "" && given !== false
    const inner = /^\$\{\{ (.*) \}\}$/.exec(expression)?.[1] as string
    const result = inner.split(" || ").map((both) =>
      both.split(" && ").map(value).reduce((left, right) => truthy(left) ? right : left)
    ).reduce((left, right) => truthy(left) ? left : right)
    return result === false ? "" : String(result)
  }

  it("is the read token for a pull request, and never the token that writes", () => {
    expect(tokenFor("pull_request", { read: "r", write: "w" })).toBe("r")
    // No read token: a pull request is given no token, where it was given the one that writes.
    expect(tokenFor("pull_request", { write: "w" })).toBe("")
    expect(tokenFor("pull_request", {})).toBe("")
  })

  it("is the token that writes for every other event on the default branch, and never the read token", () => {
    for (const event of ["push", "schedule", "workflow_dispatch"]) {
      expect(tokenFor(event, { read: "r", write: "w" })).toBe("w")
      expect(tokenFor(event, { read: "r" })).toBe("")
    }
  })

  it("gives a tag named after the default branch only the read token", () => {
    for (const event of ["push", "workflow_dispatch"]) {
      expect(tokenFor(event, { read: "r", write: "w" }, "default", "tag")).toBe("r")
      expect(tokenFor(event, { write: "w" }, "default", "tag")).toBe("")
    }
  })

  it("is the read token for a run of any other branch, and never the token that writes", () => {
    // A push to a pull request's branch in the same repository runs code nobody has reviewed.
    for (const event of ["push", "merge_group", "workflow_dispatch"]) {
      expect(tokenFor(event, { read: "r", write: "w" }, "other")).toBe("r")
      expect(tokenFor(event, { write: "w" }, "other")).toBe("")
      expect(tokenFor(event, {}, "other")).toBe("")
    }
  })
})
