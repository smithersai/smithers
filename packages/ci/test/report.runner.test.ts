/**
 * The steps a replay does not run because they only send a job's results out, named in the report.
 */

import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ReplayReport } from "../src/contract/ReplayReport.ts"
import { html, text } from "../src/report/index.ts"

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
