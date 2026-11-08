import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { parseWorkflow } from "../../../.smithers/flows/release/release-rehearsal.mjs"

const workflow = (name) => parseWorkflow(readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), "utf8"))

test("Linux jobs running terminal evidence install ffmpeg before their target commands", () => {
  const selected = Object.entries(workflow("ci").jobs).filter(([, job]) =>
    JSON.stringify([job["runs-on"], job.strategy?.matrix]).includes("ubuntu") &&
    job.steps.some((step) => /\/\/packages\/(?:testing:|\.\.\.)/.test(step.run ?? "")))
  assert.ok(selected.length > 0, "the generated workflow must run the testing package")
  selected.push(["release.publish", workflow("release").jobs.publish])
  for (const [name, job] of selected) {
    const install = job.steps.findIndex((step) => step.name === "Install system packages")
    assert.ok(install >= 0, `${name}: install the terminal renderer`)
    assert.match(job.steps[install].run, /apt-get install[^\n]*'ffmpeg'/, `${name}: ffmpeg supplies both ffmpeg and ffprobe`)
    const targets = job.steps.findIndex((step) => /pnpm exec (?:smthrs|smithers-build) (?:test|ci) /.test(step.run ?? ""))
    assert.ok(targets > install, `${name}: the renderer must exist before testing`)
  }
})
