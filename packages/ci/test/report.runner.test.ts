/**
 * The steps a replay does not run because they only send a job's results out, named in the report.
 */

import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { Inventory, Job } from "../src/contract/Inventory.ts"
import { ReplayReport } from "../src/contract/ReplayReport.ts"
import { reportOf, runnerStepsOf } from "../src/replay/Summary.ts"
import { html, text } from "../src/report/index.ts"

const example: ReplayReport = Schema.decodeUnknownSync(ReplayReport)(
  JSON.parse(readFileSync(new URL("./fixtures/replay-report.example.json", import.meta.url), "utf8"))
)

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

  it("are listed in the text and the HTML report, and not when there are none", () => {
    const report: ReplayReport = {
      ...example,
      runnerSteps: [
        { job: "ci.yml:main", action: "codecov/codecov-action@v5", why: "it sends coverage to Codecov" },
        {
          job: "ci.yml:x",
          action: "actions/upload-artifact@<v4>",
          why: "it stores files for other jobs and for people"
        }
      ]
    }
    expect(text(report)).toContain([
      "not run here: your runner runs them, in the workflow apply writes",
      "ci.yml:main  codecov/codecov-action@v5: it sends coverage to Codecov",
      "ci.yml:x     actions/upload-artifact@<v4>: it stores files for other jobs and for people"
    ].join("\n"))
    expect(html(report)).toContain("<h2>Not run here: your runner runs them, in the workflow apply writes</h2>")
    expect(html(report)).toContain("<code>actions/upload-artifact@&lt;v4&gt;</code>: it stores files")
    expect(text(example)).not.toContain("not run here")
    expect(html(example)).not.toContain("Not run here")
  })

  it("are in the report when there are any, and absent when there are none", () => {
    const inventory: Inventory = { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [] }
    const steps = [{ job: "ci.yml:main", action: "codecov/codecov-action@v5", why: "it sends coverage to Codecov" }]
    expect(reportOf(inventory, [], { left: [], flaky: 0, runnerSteps: steps }).runnerSteps).toEqual(steps)
    expect(reportOf(inventory, [], { left: [], flaky: 0, runnerSteps: [] })).not.toHaveProperty("runnerSteps")
    expect(reportOf(inventory, [], { left: [], flaky: 0 })).not.toHaveProperty("runnerSteps")
  })
})
