/**
 * Every suite in this workspace is reachable from a command CI runs.
 *
 * Ported from the Smithers 0.x `packages/smithers/tests/test-script-wiring-gate`
 * suite. The defect it guards is the quiet one: a package with a `test/`
 * directory and no `scripts.test` never runs, and every config-level assertion
 * about it stays green while it does. The 0.x version drove a standalone
 * `check-smithers-test-script.mjs` against synthetic fixtures; the script is
 * gone, so what survives is the claim itself, checked against the real tree.
 *
 * Run it with `node --test packages/repo-targets/contracts/test-script-wiring.test.mjs`.
 */
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { parseWorkflow } from "../../../.smithers/flows/release/release-rehearsal.mjs"
import { repoRoot as root } from "../scripts/workspace-packages.mjs"

const readManifest = (path) => JSON.parse(readFileSync(path, "utf8"))

const rootManifest = readManifest(join(root, "package.json"))

/** Every workspace member the root manifest's globs name. */
const members = rootManifest.workspaces.flatMap((glob) => {
  if (!glob.endsWith("/*")) return existsSync(join(root, glob, "package.json")) ? [glob] : []
  const parent = glob.slice(0, -2)
  if (!existsSync(join(root, parent))) return []
  return readdirSync(join(root, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, parent, entry.name, "package.json")))
    .map((entry) => `${parent}/${entry.name}`)
})

const hasTests = (directory) => {
  const candidates = ["test", "tests", "src/test"]
  return candidates.some((name) => {
    const path = join(root, directory, name)
    return existsSync(path) && statSync(path).isDirectory()
  })
}

describe("test-script wiring", () => {
  it("finds the workspace members the root manifest declares", () => {
    assert.ok(members.length > 20, `expected a populated workspace, found ${members.length}`)
  })

  it("gives every member with a test directory a test script", () => {
    for (const directory of members) {
      if (!hasTests(directory)) continue
      const manifest = readManifest(join(root, directory, "package.json"))
      assert.ok(
        manifest.scripts?.test,
        `${directory} has tests and no scripts.test, so nothing in CI runs them`
      )
    }
  })

  it("prepares source declarations before root aggregators fan out recursively", () => {
    assert.equal(rootManifest.scripts.test, "pnpm run sidecars && pnpm --recursive --if-present run test")
    assert.equal(rootManifest.scripts.check, "pnpm run sidecars && pnpm --recursive --if-present run check")
    assert.equal(rootManifest.scripts.lint, "pnpm run sidecars && pnpm --recursive --if-present run lint")
  })

  it("keeps the pnpm workspace globs and the root manifest globs identical", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
    const block = workspace.match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    assert.ok(block, "pnpm-workspace.yaml must declare a packages block")
    const globs = block
      .split("\n")
      .slice(1)
      .filter((line) => line.startsWith("  - "))
      .map((line) => line.slice(4).replaceAll("\"", ""))
    assert.deepEqual(
      globs,
      rootManifest.workspaces,
      "pnpm installs what pnpm-workspace.yaml names and the recursive scripts fan out over the same set; "
        + "a member in one and not the other is installed but never tested, or tested and never installed"
    )
  })
})

/** Every `*.test.*` file under `directory`, repository-relative. */
const testFiles = (directory, extension) =>
  readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(`.test${extension}`) && !entry.parentPath.includes("node_modules"))
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort()

/**
 * Test files deliberately outside every target, with the reason. A suite that
 * no target names never runs, so the default is an owner, not an entry here.
 */
const unownedTests = new Map([])

describe("test-file ownership", () => {
  // The repository's own automation suites: the contract gates this package
  // owns and the flow modules for evidence, issue claims and releases.
  const declarations = ["PACKAGE.ts", "packages/repo-targets/PACKAGE.ts", ".smithers/flows/PACKAGE.ts"]
    .map((path) => readFileSync(join(root, path), "utf8"))
    .join("\n")
  const suites = ["packages/repo-targets/contracts", ".smithers/flows/evidence", ".smithers/flows/issue-claim", ".smithers/flows/release"]
    .flatMap((directory) => testFiles(directory, ".mjs"))

  it("finds the automation suites", () => {
    assert.ok(suites.includes(".smithers/flows/issue-claim/issue-claim.test.mjs"))
    assert.ok(suites.includes("packages/repo-targets/contracts/test-script-wiring.test.mjs"))
  })

  it("names every automation suite in a target's test runner", () => {
    const orphans = suites.filter((path) => !unownedTests.has(path) && !declarations.includes(`Smithers.file("//${path}")`))
    assert.deepEqual(orphans, [], "each suite needs a Smithers.testRunner entry or a reasoned unownedTests entry")
  })

  it("keeps the exclusion list free of owned or deleted suites", () => {
    for (const path of unownedTests.keys()) assert.ok(suites.includes(path) && !declarations.includes(`//${path}"`), path)
  })

  it("selects the automation targets in their required jobs", () => {
    const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))
    assert.notEqual(workflow.jobs.test["continue-on-error"], true)
    assert.notEqual(workflow.jobs.scripts["continue-on-error"], true)
    const scripts = workflow.jobs.scripts.steps.flatMap((step) => step.run ? [step.run] : []).join("\n")
    for (const label of ["//.smithers/flows:issueClaim", "//.smithers/flows:evidenceBindings", "//.smithers/flows:releaseRehearsal", "//.smithers/flows:releaseVersion"]) {
      assert.ok(scripts.includes(`smthrs test '${label}'`), label)
    }
    const inventory = JSON.parse(readFileSync(join(root, ".smithers/target-index.json"), "utf8"))
    const expected = [...new Set(inventory.filter(target =>
      target.package.startsWith("packages/") &&
      target.kinds.some(kind => ["build", "test", "lint", "docs"].includes(kind))
    ).map(target => "//" + target.package + ":*"))].sort()
    const selected = Object.entries(workflow.jobs).filter(([name]) => /^test(?:-[2-8])?$/.test(name))
    assert.equal(selected.length, 8, "all package shards remain required jobs")
    const patterns = selected.flatMap(([name, job]) => {
      assert.notEqual(job["continue-on-error"], true, name)
      const commands = job.steps.flatMap(step => step.run?.includes("pnpm exec smthrs ci ") ? [step.run] : [])
      assert.equal(commands.length, 1, name + " selects one package partition")
      return [...commands[0].matchAll(/'(\/\/packages\/[^']+:\*)'/g)].map(match => match[1])
    })
    assert.deepEqual(patterns.sort(), expected, "each package's complete target set runs once across the required CI shards")
    assert.notEqual(workflow.jobs.repository["continue-on-error"], true)
  })
})

