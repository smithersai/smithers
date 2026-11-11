import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { assertSmokeNpmSupport } from "./release-npm-support.mjs"
import { parseWorkflow } from "./release-rehearsal.mjs"

test("release smoke enforces the certified npm floor at its boundaries", () => {
  for (const version of ["11.16.0", "11.16.1", "12.0.0"]) {
    assert.doesNotThrow(() => assertSmokeNpmSupport(version), version)
  }
  for (const version of ["10.9.3", "11.15.9", "11.16.0-rc.1", "invalid"]) {
    assert.throws(() => assertSmokeNpmSupport(version), /requires npm >=11\.16\.0/, version)
  }
})

test("the actual CI and release workflows install a smoke-supported npm before their gates", () => {
  for (const [filename, job, gate] of [["ci.yml", "test", "Workspace targets"], ["release.yml", "publish", "Release gates"]]) {
    const workflow = parseWorkflow(readFileSync(new URL("../../../.github/workflows/" + filename, import.meta.url), "utf8"))
    const steps = workflow.jobs[job].steps
    const install = steps.find((step) => step.name === "Install certified npm")
    const match = /npm install --global 'npm@([^']+)'/.exec(install?.run ?? "")
    assert.ok(match, `${filename} has no exact npm installation`)
    assertSmokeNpmSupport(match[1])
    assert.match(install.run, new RegExp(`test "\\$\\(npm --version\\)" = '${match[1].replaceAll(".", "\\.")}'`))
    assert.equal(install.if, undefined)
    assert.ok(steps.indexOf(install) < steps.indexOf(steps.find((step) => step.name === gate)))
  }
})
