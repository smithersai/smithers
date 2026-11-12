import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { runMutations, verifyOutcome } from "./check-mutations.mjs"
import { mutants } from "./manifest.mjs"
import { repoRoot } from "../../../../packages/repo-targets/scripts/workspace-packages.mjs"

test("mutation evidence refuses surviving, unloaded, empty, interrupted and infrastructure failures", () => {
  const mutant = { id: "fixture", test: "behavior oracle" }
  const result = () => ({ status: 1, signal: null, applied: true, report: { success: false,
    testResults: [{ status: "failed", message: "", assertionResults: [{ status: "failed", fullName: "behavior oracle", failureMessages: ["AssertionError: independent output differs"] }] }] } })
  assert.equal(verifyOutcome(result(), false, mutant).length, 1)
  for (const mutate of [
    (x) => { x.status = 0 }, (x) => { x.signal = "SIGTERM" }, (x) => { x.applied = false },
    (x) => { x.report.testResults[0].message = "missing module" },
    (x) => { x.report.testResults[0].assertionResults = [] },
    (x) => { x.report.testResults[0].assertionResults[0].failureMessages = ["Error: missing module"] },
    (x) => { x.report.testResults[0].assertionResults[0].fullName = "unrelated failure" }
  ]) { const value = result(); mutate(value); assert.throws(() => verifyOutcome(value, false, mutant)) }
  assert.throws(() => verifyOutcome(result(), true, mutant))
})

test("the mutation manifest names a behavioral assertion for every unique site", () => {
  assert.equal(new Set(mutants.map((mutant) => mutant.id)).size, mutants.length)
  assert.ok(mutants.length >= 11)
  for (const mutant of mutants) {
    assert.ok(mutant.assertion.length > 20)
    assert.ok(mutant.test.length > 10)
    assert.notEqual(mutant.original, mutant.replacement)
    assert.doesNotMatch(mutant.package, /control|sync|jj|engine-store|run-store|journal/)
  }
})

test("every declared mutation still names exactly one current source site", () => {
  for (const mutant of mutants) {
    const path = join(repoRoot, mutant.package, mutant.source)
    assert.equal(readFileSync(path, "utf8").split(mutant.original).length - 1, 1,
      `${mutant.id}: ${mutant.source} must contain its mutation site exactly once`)
  }
})

test("mutation failures cannot be overwritten or reused as fresh evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-mutation-preservation-"))
  try {
    const prior = join(directory, "failure.json")
    writeFileSync(prior, "prior failure")
    assert.throws(() => runMutations(directory), /prior evidence is immutable/)
    assert.equal(readFileSync(prior, "utf8"), "prior failure")
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("a runner that ends without its report is diagnosed by mutant, ending and log", () => {
  for (const [runner, ending] of [
    ["process.stderr.write('fixture runner stderr'); process.exit(1)", /exit status 1/],
    ["process.kill(process.pid, 'SIGKILL')", /signal SIGKILL/],
    ["process.stdout.write('x'.repeat(5 * 1024 * 1024))", /ENOBUFS.*signal SIGTERM/]
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "smithers-mutation-runner-"))
    try {
      const pkg = join(directory, "package")
      mkdirSync(join(pkg, "src"), { recursive: true })
      mkdirSync(join(pkg, "node_modules", "vitest"), { recursive: true })
      writeFileSync(join(pkg, "package.json"), "{}")
      writeFileSync(join(pkg, "src", "site.mjs"), "export const over = (a, b) => a > b\n")
      writeFileSync(join(pkg, "node_modules", "vitest", "package.json"), "{}")
      writeFileSync(join(pkg, "node_modules", "vitest", "vitest.mjs"), `${runner}\n`)
      const artifacts = join(directory, "artifacts")
      const mutant = { id: "fixture", package: pkg, source: "src/site.mjs", original: "a > b", replacement: "a >= b", file: "site.test.mjs", test: "fixture oracle" }
      const log = join(artifacts, "fixture-baseline.log").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const diagnosis = new RegExp(`fixture-baseline: runner ended by .*${ending.source}.* without a complete report; log ${log}`)
      assert.throws(() => runMutations(artifacts, [mutant]), diagnosis)
      if (runner.includes("fixture runner stderr")) {
        assert.match(readFileSync(join(artifacts, "failure.json"), "utf8"), /fixture runner stderr/)
      }
      assert.match(JSON.parse(readFileSync(join(artifacts, "failure.json"), "utf8")).message, diagnosis)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})


test("a real mutation baseline loads migrated dependencies and the mutant trips its behavioral assertion", { timeout: 180_000 }, () => {
  const witness = mutants.find((mutant) => mutant.id === "event-byte-equality")
  assert.ok(witness)
  const directory = mkdtempSync(join(tmpdir(), "smithers-mutation-loader-"))
  try {
    const result = runMutations(directory, [witness])
    assert.equal(result.status, "passed")
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].id, witness.id)
    assert.equal(result.results[0].status, "killed")
    assert.ok(result.results[0].assertions.some((entry) => entry.status === "failed"))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("malformed and incomplete mutation reports retain attempt and artifact context", () => {
  for (const contents of ["{", "{}"]) {
    const directory = mkdtempSync(join(tmpdir(), "smithers-mutation-report-"))
    try {
      const pkg = join(directory, "package")
      mkdirSync(join(pkg, "src"), { recursive: true })
      mkdirSync(join(pkg, "node_modules", "vitest"), { recursive: true })
      writeFileSync(join(pkg, "package.json"), "{}")
      writeFileSync(join(pkg, "src", "site.mjs"), "export const over = (a, b) => a > b\n")
      writeFileSync(join(pkg, "node_modules", "vitest", "package.json"), "{}")
      writeFileSync(join(pkg, "node_modules", "vitest", "vitest.mjs"),
        "import { writeFileSync } from 'node:fs'; const path = process.argv.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length); writeFileSync(path, " + JSON.stringify(contents) + ");")
      const artifacts = join(directory, "artifacts")
      const mutant = { id: "fixture", package: pkg, source: "src/site.mjs", original: "a > b", replacement: "a >= b", file: "site.test.mjs", test: "fixture oracle" }
      assert.throws(() => runMutations(artifacts, [mutant]), (error) => {
        assert.match(String(error), /fixture-baseline:/)
        assert.ok(String(error).includes(join(artifacts, "fixture-baseline.json")))
        assert.ok(String(error).includes(join(artifacts, "fixture-baseline.log")))
        return true
      })
      assert.match(JSON.parse(readFileSync(join(artifacts, "failure.json"), "utf8")).message, /fixture-baseline:/)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})


test("long runner logs retain both assertion diagnostics and the stderr tail", () => {
  const directory = mkdtempSync(join(tmpdir(), "smithers-mutation-diagnostics-"))
  try {
    const pkg = join(directory, "package")
    mkdirSync(join(pkg, "src"), { recursive: true })
    mkdirSync(join(pkg, "node_modules", "vitest"), { recursive: true })
    writeFileSync(join(pkg, "package.json"), "{}")
    writeFileSync(join(pkg, "src", "site.mjs"), "export const over = (a, b) => a > b\n")
    writeFileSync(join(pkg, "node_modules", "vitest", "package.json"), "{}")
    const report = { success: false, testResults: [{ status: "failed", message: "",
      assertionResults: [{ status: "failed", fullName: "fixture oracle",
        failureMessages: ["AssertionError: fixture assertion detail"] }] }] }
    writeFileSync(join(pkg, "node_modules", "vitest", "vitest.mjs"),
      "import { writeFileSync } from 'node:fs'; const path = process.argv.find(arg => arg.startsWith('--outputFile=')).slice('--outputFile='.length);"
      + "writeFileSync(path, " + JSON.stringify(JSON.stringify(report)) + ");"
      + "process.stderr.write('x'.repeat(9000) + 'fixture stderr tail'); process.exit(1);")
    const artifacts = join(directory, "artifacts")
    const mutant = { id: "fixture", package: pkg, source: "src/site.mjs", original: "a > b", replacement: "a >= b", file: "site.test.mjs", test: "fixture oracle" }
    assert.throws(() => runMutations(artifacts, [mutant]), (error) => {
      assert.match(String(error), /fixture assertion detail/)
      assert.match(String(error), /fixture stderr tail/)
      assert.ok(String(error).length < 9000)
      return true
    })
    const failure = JSON.parse(readFileSync(join(artifacts, "failure.json"), "utf8")).message
    assert.match(failure, /fixture assertion detail/)
    assert.match(failure, /fixture stderr tail/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
