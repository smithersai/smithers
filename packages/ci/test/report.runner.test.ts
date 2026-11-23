/**
 * The steps a replay does not run because they only send a job's results out, named in the report.
 */

import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ReplayReport } from "../src/contract/ReplayReport.vibe"
import { html, text } from "../src/report/index.vibe"

const example: ReplayReport = Schema.decodeUnknownSync(ReplayReport)(
  JSON.parse(readFileSync(new URL("./fixtures/replay-report.example.json", import.meta.url), "utf8"))
)

describe("the steps your runner runs", () => {
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
})

describe("the steps the workflow apply writes leaves out", () => {
  it("are listed with why in the text and the HTML report, and not when there are none", () => {
    const why = "reads steps, which a step of the workflow apply writes does not have"
    const report: ReplayReport = {
      ...example,
      stepsLeftOut: [
        { job: "ci.yml:checks", action: "actions/upload-artifact@v4", why },
        { job: "ci.yml:x", action: "codecov/codecov-action@<v5>", why: "holds a value shaped like a secret" }
      ]
    }
    expect(text(report)).toContain([
      "left out of the workflow apply writes: its job was replayed without it",
      `ci.yml:checks  actions/upload-artifact@v4 ${why}`,
      "ci.yml:x       codecov/codecov-action@<v5> holds a value shaped like a secret"
    ].join("\n"))
    expect(html(report)).toContain("<h2>Left out of the workflow apply writes: its job was replayed without it</h2>")
    expect(html(report)).toContain("<code>codecov/codecov-action@&lt;v5&gt;</code> holds a value shaped like a secret")
    expect(text(example)).not.toContain("left out of the workflow apply writes")
    expect(html(example)).not.toContain("Left out of the workflow apply writes")
  })
})
