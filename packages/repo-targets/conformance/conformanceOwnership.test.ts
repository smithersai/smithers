import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { it } from "node:test"

const root = resolve(import.meta.dirname, "../../..")

it("runs repository conformance from the repo-targets package, outside the flows library suite", () => {
  const targets = readFileSync(resolve(root, "packages/repo-targets/PACKAGE.ts"), "utf8")
  const runner = readFileSync(resolve(root, "packages/repo-targets/conformance/repositoryConformance.test.ts"), "utf8")
  assert.ok(
    targets.includes(
      "runner: Smithers.testRunner([Smithers.file(\"//packages/repo-targets/conformance/repositoryConformance.test.ts\")])"
    )
  )
  for (
    const owner of [
      "ci",
      "publication",
      "coverage",
      "spawnContainment",
      "workspaceInventory",
      "conformanceOwnership",
      "quickstartExamples"
    ]
  ) {
    const path = `packages/repo-targets/conformance/${owner}.test.ts`
    assert.ok(existsSync(resolve(root, path)), `${path} must be owned by repo-targets`)
    assert.ok(runner.includes(`import "./${owner}.test.ts"`), `${path} must execute in the conformance runner`)
  }
  // The target's sources are every suite beside the runner.
  assert.ok(targets.includes("Smithers.glob(\"//packages/repo-targets/conformance/**/*.ts\")"))
  for (const name of ["vitestCoverageIsolation", "spawnContainment"]) {
    assert.equal(existsSync(resolve(root, `packages/smithers/flows/test/${name}.test.ts`)), false)
  }
})
