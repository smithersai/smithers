// What a gate step's output says (apps/mvp/ci/gate.sh), short enough for the step's kept output:
//   gate-summary.mjs results <vitest json>      counts, then each failed test and the start of its first failure
//   gate-summary.mjs coverage <json-summary>    the totals, then each file under 100% with its four percentages
import { readFileSync } from "node:fs"

const [kind, file] = process.argv.slice(2)
const data = JSON.parse(readFileSync(file, "utf8"))
const root = `${process.cwd()}/`
if (kind === "results") {
  console.log(`gate: tests ${data.numTotalTests} passed ${data.numPassedTests} failed ${data.numFailedTests} skipped ${data.numPendingTests}`)
  // Each file's time, for the shards' balance (gate-shards.mjs reads them back as gate-durations.json).
  for (const suite of data.testResults) console.log(`TIME ${Math.round(suite.endTime - suite.startTime)} ${suite.name.replace(root, "")}`)
  for (const suite of data.testResults) {
    const failed = suite.assertionResults.filter((test) => test.status === "failed")
    const name = suite.name.replace(root, "")
    if (failed.length === 0 && suite.status === "failed") console.log(`FAILED ${name} [file] ${String(suite.message).slice(0, 300)}`)
    for (const test of failed) {
      console.log(`FAILED ${name} > ${test.fullName} :: ${String(test.failureMessages?.[0] ?? "").split("\n").slice(0, 3).join(" ").slice(0, 300)}`)
    }
  }
} else if (kind === "coverage") {
  const metrics = ["lines", "branches", "functions", "statements"]
  console.log(`gate: coverage ${metrics.map((metric) => `${metric} ${data.total[metric].pct}%`).join(" ")}`)
  for (const [path, entry] of Object.entries(data)) {
    if (path === "total" || metrics.every((metric) => entry[metric].pct === 100)) continue
    console.log(`UNDER ${path.replace(root, "")} ${metrics.map((metric) => entry[metric].pct).join("/")}`)
  }
} else {
  console.error("usage: gate-summary.mjs results|coverage <file>")
  process.exit(2)
}
