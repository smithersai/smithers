/** The steps a person's runner runs and a replay does not: each kept step of a replayed job, with why. */
import { describe, expect, it } from "vitest"
import type { Inventory, Job } from "../../src/contract/Inventory.ts"
import { reportOf, runnerStepsOf, stepsLeftOutOf } from "../../src/replay/Summary.ts"

const job = (id: string, kept?: Job["kept"], unkept?: Job["unkept"]): Job => ({
  id,
  source: "github-actions",
  file: "ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  steps: [],
  unsupported: [],
  ...(kept === undefined ? {} : { kept }),
  ...(unkept === undefined ? {} : { unkept })
})

describe("the steps your runner runs", () => {
  it("are those of the replayed jobs, each with what its action does", () => {
    const inventory: Inventory = {
      version: 1,
      repository: "r",
      commit: "c",
      toolchains: [],
      jobs: [
        job("ci.yml:main", [{ uses: "codecov/codecov-action@v5" }, { uses: "Some/Other-Action@v1" }]),
        job("ci.yml:left", [{ uses: "actions/upload-artifact@v4" }]),
        job("ci.yml:plain")
      ]
    }
    expect(runnerStepsOf(inventory, [{ job: "ci.yml:main" }, { job: "ci.yml:plain" }])).toEqual([
      { job: "ci.yml:main", action: "codecov/codecov-action@v5", why: "it sends coverage to Codecov" },
      { job: "ci.yml:main", action: "Some/Other-Action@v1", why: "it sends the job's results out" }
    ])
  })

  it("are in the report when there are any, and absent when there are none", () => {
    const inventory: Inventory = { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [] }
    const steps = [{ job: "ci.yml:main", action: "codecov/codecov-action@v5", why: "it sends coverage to Codecov" }]
    expect(reportOf(inventory, [], { left: [], flaky: 0, runnerSteps: steps }).runnerSteps).toEqual(steps)
    expect(reportOf(inventory, [], { left: [], flaky: 0, runnerSteps: [] })).not.toHaveProperty("runnerSteps")
    expect(reportOf(inventory, [], { left: [], flaky: 0 })).not.toHaveProperty("runnerSteps")
  })
})

describe("the steps the workflow apply writes leaves out", () => {
  const why = "reads steps, which a step of the workflow apply writes does not have"

  it("are those of the replayed jobs, each with why", () => {
    const inventory: Inventory = {
      version: 1,
      repository: "r",
      commit: "c",
      toolchains: [],
      jobs: [
        job("ci.yml:checks", undefined, [{ uses: "actions/upload-artifact@v4", why }]),
        job("ci.yml:left", undefined, [{ uses: "codecov/codecov-action@v5", why }]),
        job("ci.yml:plain")
      ]
    }
    expect(stepsLeftOutOf(inventory, [{ job: "ci.yml:checks" }, { job: "ci.yml:plain" }])).toEqual([
      { job: "ci.yml:checks", action: "actions/upload-artifact@v4", why }
    ])
  })

  it("are in the report when there are any, and absent when there are none", () => {
    const inventory: Inventory = { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [] }
    const steps = [{ job: "ci.yml:checks", action: "actions/upload-artifact@v4", why }]
    expect(reportOf(inventory, [], { left: [], flaky: 0, stepsLeftOut: steps }).stepsLeftOut).toEqual(steps)
    expect(reportOf(inventory, [], { left: [], flaky: 0, stepsLeftOut: [] })).not.toHaveProperty("stepsLeftOut")
    expect(reportOf(inventory, [], { left: [], flaky: 0 })).not.toHaveProperty("stepsLeftOut")
  })
})
