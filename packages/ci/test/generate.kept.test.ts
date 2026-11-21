/**
 * The steps the generated workflow writes for a step that only sends a job's results out (`Inventory.KeptStep`).
 */

import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { ci, type Job } from "../src/contract/Inventory.ts"
import { files } from "../src/generate/index.ts"
import { keepValue, keptDirectory, keptRuns, keptSteps } from "../src/generate/Kept.ts"
import { workflowPath } from "../src/generate/Render.ts"
import type { StepTarget } from "../src/generate/Steps.ts"
import * as Yaml from "../src/generate/Yaml.ts"

const job: Job = {
  id: "ci.yml:main",
  source: "github-actions",
  file: ".github/workflows/ci.yml",
  name: "main",
  needs: [],
  triggers: ["push"],
  matrix: [{ python: "3.12" }],
  steps: [],
  unsupported: []
}

/** The steps as GitHub reads them from the generated workflow. */
const read = (items: ReadonlyArray<Yaml.Item>): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  (parseYaml(Yaml.document(Yaml.mapping([Yaml.entry("steps", Yaml.sequence(items))]))) as {
    readonly steps: ReadonlyArray<Readonly<Record<string, unknown>>>
  }).steps

describe("a kept step in the generated workflow", () => {
  it("puts its job's checkout in the workspace, then runs as the repository wrote it, with the variant's values", () => {
    const steps = read(keptSteps(
      {
        uses: "codecov/codecov-action@303a32d7a59b442fa8d48b6a1cc6825c09c847a5",
        with: { name: "${{ matrix.python }}", token: "${{ secrets.CODECOV_TOKEN }}" }
      },
      { job, variant: { python: "3.12" }, machine: "ci.yml:main 3.12", entry: "matrix.os == 'ubuntu-latest'" },
      0
    ))
    expect(steps).toEqual([
      {
        name: "Files of ci.yml:main (python 3.12)",
        if: "${{ matrix.os == 'ubuntu-latest' && (success()) }}",
        run: `find "$GITHUB_WORKSPACE" -mindepth 1 -maxdepth 1 -exec rm -rf {} +\ncp -a "${
          keptDirectory(0)
        }/." "$GITHUB_WORKSPACE/"\n`
      },
      {
        name: "codecov/codecov-action@303a32d7a59b442fa8d48b6a1cc6825c09c847a5: ci.yml:main (python 3.12)",
        if: "${{ matrix.os == 'ubuntu-latest' && (success()) }}",
        uses: "codecov/codecov-action@303a32d7a59b442fa8d48b6a1cc6825c09c847a5",
        with: { name: "3.12", token: "${{ secrets.CODECOV_TOKEN }}" }
      }
    ])
  })

  it("keeps its id, name, condition, variables, tolerated failure and time limit, each matrix value written in", () => {
    const [, step] = read(keptSteps(
      {
        uses: "actions/upload-artifact@v4",
        id: "up",
        name: "Upload ${{ matrix.python }}",
        if: "${{ always() && matrix.Python != 'it''s' }}",
        with: { name: "cov-${{ format('{0}', matrix.python) }}", path: "coverage.xml" },
        env: { WHO: "${{ matrix.missing }}x" },
        continueOnError: "true",
        timeoutMinutes: "5"
      },
      { job, variant: { python: "3.12" }, machine: "m", entry: "matrix.leg == '2'" },
      3
    ))
    expect(step).toEqual({
      name: "Upload 3.12: ci.yml:main (python 3.12)",
      id: "up-3",
      if: "${{ matrix.leg == '2' && (always() && '3.12' != 'it''s') }}",
      uses: "actions/upload-artifact@v4",
      with: { name: "cov-${{ format('{0}', '3.12') }}", path: "coverage.xml" },
      env: { WHO: "${{ '' }}x" },
      "continue-on-error": true,
      "timeout-minutes": 5
    })
  })

  it("reads a condition written as text around an expression as text, and a tolerated failure decided by an expression", () => {
    const [, step] = read(keptSteps(
      { uses: "codecov/codecov-action@v5", if: "github.event_name == 'push'", continueOnError: "${{ matrix.x }}" },
      { job, variant: {}, machine: "m", entry: "matrix.os == 'ubuntu-latest'" },
      1
    ))
    expect(step).toEqual({
      name: "codecov/codecov-action@v5: ci.yml:main",
      if: "${{ matrix.os == 'ubuntu-latest' && (github.event_name == 'push') }}",
      uses: "codecov/codecov-action@v5",
      "continue-on-error": "${{ '' }}"
    })
  })
})

describe("where the kept steps run", () => {
  const target = (label: string, of: Job, variant: Readonly<Record<string, string>>, machine?: string) =>
    ({ label, job: of.id, variant, ...(machine === undefined ? {} : { machine }) }) as unknown as StepTarget
  const kept = { uses: "codecov/codecov-action@v5" }
  const matrix: Job = {
    ...job,
    runsOn: "${{ matrix.os }}",
    matrix: [{ os: "ubuntu-latest" }, { os: "ubuntu-24.04-arm" }, { os: "self-hosted,gpu" }],
    kept: [kept, { uses: "actions/upload-artifact@v4" }]
  }
  const plain: Job = { ...job, id: "ci.yml:plain", runsOn: "ubuntu-latest" }

  it("is each variant's matrix entry, once per variant, with a directory for each machine", () => {
    const runs = keptRuns([plain, matrix], {
      targets: [
        target("a1", matrix, { os: "ubuntu-latest" }, "m1"),
        target("a2", matrix, { os: "ubuntu-latest" }, "m1"),
        target("b1", matrix, { os: "ubuntu-24.04-arm" }, "m2"),
        target("c1", matrix, { os: "self-hosted,gpu" }, "m3"),
        target("p1", plain, {}, "p")
      ],
      legs: [{ id: "2", runner: "ubuntu-24.04-arm", name: "", toolchains: [], labels: ["b1"] }]
    })
    expect(runs.map((run) => [run.step.uses, run.place.machine, run.place.entry, run.index])).toEqual([
      ["codecov/codecov-action@v5", "m1", "matrix.os == 'ubuntu-latest'", 0],
      ["actions/upload-artifact@v4", "m1", "matrix.os == 'ubuntu-latest'", 0],
      ["codecov/codecov-action@v5", "m2", "matrix.leg == '2'", 1],
      ["actions/upload-artifact@v4", "m2", "matrix.leg == '2'", 1],
      ["codecov/codecov-action@v5", "m3", "join(matrix.os, ',') == 'self-hosted,gpu'", 2],
      ["actions/upload-artifact@v4", "m3", "join(matrix.os, ',') == 'self-hosted,gpu'", 2]
    ])
    expect(JSON.parse(keepValue(runs))).toEqual({ m1: keptDirectory(0), m2: keptDirectory(1), m3: keptDirectory(2) })
  })

  it("is nowhere for a job whose targets have no machine, or that names no runner", () => {
    expect(keptRuns([matrix], { targets: [target("a1", matrix, { os: "ubuntu-latest" })], legs: [] })).toEqual([])
    const { runsOn: _runsOn, ...unnamed } = { ...matrix, matrix: [] }
    expect(keptRuns([unnamed], { targets: [target("x", unnamed, {}, "m")], legs: [] })[0]?.place.entry).toBe(
      "matrix.os == ''"
    )
  })
})

describe("the workflow apply writes for a job with a kept step", () => {
  it("keeps the job's machine and runs the step after the build, under the entry that runs the job", () => {
    const tested: Job = {
      ...job,
      runsOn: "ubuntu-latest",
      matrix: [],
      steps: [{ id: "ci.yml:main:1", command: "echo covered > coverage.txt", cwd: "", env: {}, secrets: [] }],
      kept: [{ uses: "codecov/codecov-action@v5", with: { files: "coverage.txt" } }]
    }
    const generated = Effect.runSync(
      files(ci({ version: 1, repository: "r", commit: "c", toolchains: [], jobs: [tested] }))
    )
    const workflow = parseYaml(generated.find((file) => file.path === workflowPath)?.content ?? "") as {
      readonly jobs: { readonly ci: { readonly steps: ReadonlyArray<Readonly<Record<string, unknown>>> } }
    }
    const steps = workflow.jobs.ci.steps
    const build = steps.findIndex((step) => String(step["run"] ?? "").includes("smthrs ci"))
    expect(JSON.parse(String((steps[build]?.["env"] as Record<string, unknown>)["SMTHRS_KEEP_MACHINES"]))).toEqual({
      "ci.yml:main": keptDirectory(0)
    })
    expect(steps.slice(build + 1).map((step) => [step["name"], step["uses"] ?? "run"])).toEqual([
      ["Files of ci.yml:main", "run"],
      ["codecov/codecov-action@v5: ci.yml:main", "codecov/codecov-action@v5"]
    ])
  })
})
