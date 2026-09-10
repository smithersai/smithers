import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { runMutations, verifyOutcome } from "./check-mutations.mjs"
import { mutants } from "./mutations/manifest.mjs"

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
    ["process.exit(1)", /exit status 1/],
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
      assert.match(JSON.parse(readFileSync(join(artifacts, "failure.json"), "utf8")).message, diagnosis)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
})
