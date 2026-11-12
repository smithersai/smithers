/**
 * Every suite in this workspace is reachable from a command CI runs.
 *
 * Ported from the Smithers 0.x `packages/smithers/tests/test-script-wiring-gate`
 * suite. The defect it guards is the quiet one: a package with a `test/`
 * directory that no CI command reaches never runs, and every config-level
 * assertion about it stays green while it does. CI runs declared targets
 * (`pnpm exec smthrs ci|test '<label>'` in `.github/workflows/ci.yml`), not
 * the root `test` script, so a member's suites count as reachable only when it
 * owns a `test` target in `.smithers/target-index.json` and a required CI job
 * selects one. The 0.x version drove a standalone
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
import { advisoryFlags } from "./workflow-jobs.mjs"

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

const inventory = JSON.parse(readFileSync(join(root, ".smithers/target-index.json"), "utf8"))

const ciWorkflow = parseWorkflow(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))

/**
 * Whether `pattern`, a label a `smthrs` command names, selects the target
 * `//<pkg>:<name>`: the label itself, `//<pkg>:*`, or `//<dir>/...` at or
 * above the package.
 */
export const selects = (pattern, pkg, name) => {
  if (pattern === `//${pkg}:${name}` || pattern === `//${pkg}:*`) return true
  if (!pattern.endsWith("/...")) return false
  const base = pattern.slice(2, -"/...".length)
  return pkg === base || pkg.startsWith(`${base}/`)
}

/**
 * Every label a required job of `workflow` runs tests for: the patterns of each
 * `smthrs ci` or `smthrs test` step in a job with no `continue-on-error`.
 */
export const requiredTestPatterns = (workflow) =>
  Object.values(workflow.jobs).flatMap((job) =>
    advisoryFlags(job).length > 0
      ? []
      : (job.steps ?? []).flatMap((step) => {
        const command = step.run?.match(/^pnpm exec smthrs (?:ci|test) ((?:'[^']+' ?)+)/)
        return command ? [...command[1].matchAll(/'(\/\/[^']+)'/g)].map((match) => match[1]) : []
      })
  )

/**
 * The members with a test directory that CI cannot reach, one message each.
 *
 * A member is reached when it owns a `test`-kind row in the target index and a
 * required CI job selects at least one of those rows. `exempt` names the
 * members deliberately outside CI, with the reason.
 */
export const unreachedMembers = (directories, rows, patterns, exempt) =>
  directories.flatMap((directory) => {
    if (exempt.has(directory)) return []
    const tests = rows.filter((row) => row.package === directory && row.kinds.includes("test"))
    if (tests.length === 0) {
      return [`${directory} has tests and owns no test target in .smithers/target-index.json, so no CI command runs them`]
    }
    return tests.some((row) => patterns.some((pattern) => selects(pattern, row.package, row.name)))
      ? []
      : [`${directory} owns test targets and no required job in .github/workflows/ci.yml selects one`]
  })

/**
 * Members with a test directory that no required CI job reaches, with the
 * reason. A suite here never runs in CI, so the default is a target and a CI
 * step, not an entry.
 */
const unreachedExemptions = new Map([
  ["apps/mvp", "Its suites need the Postgres stack and no ci.yml job selects them; #5450 decides whether they join CI."],
  ["apps/vibelang", "No ci.yml job selects its suites; #5450 decides whether they join CI."],
  ["apps/vibelang-desktop", "No ci.yml job selects its suites; #5450 decides whether they join CI."]
])

describe("test-script wiring", () => {
  it("finds the workspace members the root manifest declares", () => {
    assert.ok(members.length > 20, `expected a populated workspace, found ${members.length}`)
  })

  it("gives every member with a test directory a test target a required CI job selects", () => {
    const tested = members.filter(hasTests)
    assert.ok(tested.includes("apps/maintainer-site"), "the scan must reach apps/")
    assert.deepEqual(unreachedMembers(tested, inventory, requiredTestPatterns(ciWorkflow), unreachedExemptions), [])
  })

  it("keeps the unreached-member exemptions pointed at members that still need one", () => {
    for (const directory of unreachedExemptions.keys()) {
      assert.ok(members.includes(directory) && hasTests(directory), `${directory} no longer has tests`)
      assert.notDeepEqual(
        unreachedMembers([directory], inventory, requiredTestPatterns(ciWorkflow), new Map()),
        [],
        `${directory} is reached by CI now; drop its exemption`
      )
    }
  })

  it("refuses a member with no test target, one no job selects, and one only an advisory job selects", () => {
    const rows = [
      { package: "apps/a", name: "test", kinds: ["test"] },
      { package: "apps/b", name: "unit", kinds: ["test"] },
      { package: "apps/c", name: "check", kinds: ["build"] },
      { package: "apps/c", name: "unit", kinds: ["test"] }
    ]
    const workflow = parseWorkflow([
      "jobs:",
      "  required:",
      "    steps:",
      "      - run: \"pnpm exec smthrs ci '//apps/a/...' --verbose\"",
      "      - run: \"pnpm exec smthrs lint '//apps/b:*'\"",
      "  advisory:",
      "    continue-on-error: ${{ matrix.advisory }}",
      "    steps:",
      "      - run: \"pnpm exec smthrs test '//apps/c:unit'\"",
      ""
    ].join("\n"))
    assert.deepEqual(requiredTestPatterns(workflow), ["//apps/a/..."])
    assert.deepEqual(unreachedMembers(["apps/a", "apps/b", "apps/c", "apps/d"], rows, requiredTestPatterns(workflow), new Map([["apps/d", "x"]])), [
      "apps/b owns test targets and no required job in .github/workflows/ci.yml selects one",
      "apps/c owns test targets and no required job in .github/workflows/ci.yml selects one"
    ])
    assert.deepEqual(unreachedMembers(["apps/e"], rows, ["//apps/..."], new Map()), [
      "apps/e has tests and owns no test target in .smithers/target-index.json, so no CI command runs them"
    ])
    assert.ok(selects("//apps/...", "apps/a", "test"))
    assert.ok(selects("//apps/a:*", "apps/a", "test"))
    assert.ok(!selects("//apps/a/...", "apps/ab", "test"))
    assert.ok(!selects("//apps/a:unit", "apps/a", "test"))
  })

  it("keeps the root aggregators fanning out recursively", () => {
    assert.equal(rootManifest.scripts.test, "pnpm --recursive --if-present run test")
    assert.equal(rootManifest.scripts.check, "pnpm --recursive --if-present run check")
    assert.equal(rootManifest.scripts.lint, "pnpm --recursive --if-present run lint")
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
    const workflow = ciWorkflow
    assert.deepEqual(advisoryFlags(workflow.jobs.test), [], "test")
    assert.deepEqual(advisoryFlags(workflow.jobs.scripts), [], "scripts")
    const scripts = workflow.jobs.scripts.steps.flatMap((step) => step.run ? [step.run] : []).join("\n")
    for (const label of ["//.smithers/flows:issueClaim", "//.smithers/flows:evidenceBindings", "//.smithers/flows:releaseRehearsal", "//.smithers/flows:releaseVersion"]) {
      assert.ok(scripts.includes(`smthrs test '${label}'`), label)
    }
    // Package suites now belong to nine disjoint, required workspace jobs.
    // Check the emitted selectors against the real target inventory so losing
    // a package, duplicating it or making its owner advisory still fails here.
    const shards = Object.entries(workflow.jobs).filter(([id]) => /^test(?:-\d+)?$/.test(id))
    assert.equal(shards.length, 9)
    const selected = shards.flatMap(([id, job]) => {
      assert.deepEqual(advisoryFlags(job), [], id)
      const steps = job.steps.filter((step) => step.name === "Workspace targets")
      assert.equal(steps.length, 1, id)
      assert.match(steps[0].run, /^pnpm exec smthrs ci /, id)
      const patterns = [...steps[0].run.matchAll(/'(\/\/packages\/[^']+:\*)'/g)].map((match) => match[1])
      assert.ok(patterns.length > 0, id)
      return patterns
    })
    const expected = [...new Set(inventory.filter((row) => row.package.startsWith("packages/") &&
      row.kinds.some((kind) => ["build", "test", "lint", "docs"].includes(kind)))
      .map((row) => `//${row.package}:*`))].sort()
    assert.ok(expected.includes("//packages/repo-targets:*"))
    assert.deepEqual(selected.sort(), expected, "every package needs exactly one required CI owner")
    assert.deepEqual(advisoryFlags(workflow.jobs.repository), [], "repository")
  })

  it("counts every spelling of continue-on-error, on the job or on a step, as advisory", () => {
    for (const value of ["true", "\"true\"", "${{ true }}", "${{ matrix.advisory }}", "false", "\"false\"", "${{ false }}"]) {
      const workflow = parseWorkflow(`jobs:\n  j:\n    continue-on-error: ${value}\n    steps:\n      - name: s\n        run: x\n        continue-on-error: ${value}\n`)
      assert.deepEqual(advisoryFlags(workflow.jobs.j), ["job", "step s"], value)
    }
    assert.deepEqual(advisoryFlags(parseWorkflow("jobs:\n  j:\n    steps:\n      - run: x\n").jobs.j), [])
    assert.deepEqual(advisoryFlags({ steps: [
      { id: "gate", "continue-on-error": false },
      { "continue-on-error": "${{ false }}" }
    ] }), ["step gate", "step 1"])
    assert.deepEqual(advisoryFlags({}), [])
  })
})

