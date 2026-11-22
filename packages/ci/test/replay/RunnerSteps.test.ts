/** The steps a person's runner runs and a replay does not: each kept step of a replayed job, with why. */
import { describe, expect, it } from "vitest"
import type { Inventory, Job } from "../../src/contract/Inventory.ts"
import { reportOf, runnerStepsOf } from "../../src/replay/Summary.ts"

const job = (id: string, kept?: Job["kept"]): Job => ({
  id,
  source: "github-actions",
  file: "ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix: [],
  steps: [],
  unsupported: [],
  ...(kept === undefined ? {} : { kept })
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
