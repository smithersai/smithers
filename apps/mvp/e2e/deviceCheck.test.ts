// The deploy's device check (e2e/deviceCheck.ts): it passes only when the build being replaced is on disk and every
// cross-build test ran and passed. A skip is a failure here, whatever it means in a local run.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { tempDirectory } from "../src/test/tempDirectory"
import { oldBuildProblem, runProblem, SPECS, verdict } from "./deviceCheck"

const build = (files: Record<string, string>) => {
  const dir = tempDirectory("device-check-")
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

test("the old build must be the one being replaced, on disk, with a page", () => {
  const good = build({ "index.html": "<!doctype html>", "version.json": '{"build":"7df7c2ecb983"}' })
  expect(oldBuildProblem(good, "7df7c2ecb983")).toBeUndefined()
  expect(oldBuildProblem(undefined, "7df7c2ecb983")).toMatch(/OLD_BUILD_DIR is not set.*7df7c2ecb983/)
  expect(oldBuildProblem(join(good, "missing"), "7df7c2ecb983")).toMatch(/OLD_BUILD_DIR .*has no index\.html.*7df7c2ecb983/)
  expect(oldBuildProblem(build({ "index.html": "", "version.json": '{"build":"7df7c2ecb983"}' }), "7df7c2ecb983")).toMatch(/empty/)
  expect(oldBuildProblem(good, "446bca4adcb9")).toMatch(/OLD_BUILD_DIR holds build 7df7c2ecb983, not 446bca4adcb9/)
})

/**
 * A Playwright JSON report of `results`, each a spec file, its project, its last result's status and, when given, the
 * test's overall status (else the one Playwright writes for that result).
 */
const report = (results: ReadonlyArray<readonly [string, string, string, string?]>) => ({
  suites: results.map(([file, project, status, overall]) => ({
    // As Playwright writes it: from the test directory, e2e/.
    file: file.replace(/^e2e\//, ""),
    specs: [{
      title: "t",
      tests: [{ projectName: project, status: overall ?? (status === "passed" ? "expected" : status === "skipped" ? "skipped" : "unexpected"), results: [{ status }] }],
    }],
  })),
})

const allPassed = SPECS.flatMap((spec) => ["local", "webkit"].map((project) => [spec, project, "passed"] as const))

test("every spec must have run and passed in every browser: a skip fails the check", () => {
  expect(verdict(report(allPassed))).toEqual([])
  expect(verdict(report(allPassed.map(([spec, project], index) => [spec, project, index === 0 ? "skipped" : "passed"] as const))))
    .toEqual([`${SPECS[0]} [local] skipped`])
  expect(verdict(report(allPassed.map(([spec, project], index) => [spec, project, index === 1 ? "failed" : "passed"] as const))))
    .toEqual([`${SPECS[0]} [webkit] failed`])
  expect(verdict(report(allPassed.slice(1)))).toEqual([`${SPECS[0]} [local] did not run`])
})

test("a run Playwright didn't expect fails the check, though its last result passed", () => {
  expect(verdict(report(allPassed.map(([spec, project], index) => [spec, project, "passed", index === 0 ? "unexpected" : "expected"] as const))))
    .toEqual([`${SPECS[0]} [local] failed`])
  expect(verdict(report(allPassed.map(([spec, project], index) => [spec, project, "passed", index === 2 ? "flaky" : "expected"] as const))))
    .toEqual([`${SPECS[1]} [local] flaky`])
  expect(verdict(report([[SPECS[0]!, "local", "passed", "flaky"], ...allPassed]))).toEqual([`${SPECS[0]} [local] flaky`])
  expect(verdict({ suites: [{ file: "device-upgrade.spec.ts", specs: [{ tests: [{ projectName: "local", status: "expected", results: [] }] }] }] }))
    .toContain(`${SPECS[0]} [local] did not run`)
})

test("an error Playwright reports outside a test fails the check", () => {
  expect(verdict({ ...report(allPassed), errors: [{ message: "global teardown failed" }, {}] }))
    .toEqual(["Playwright reported an error: global teardown failed", "Playwright reported an error: no message"])
})

test("a Playwright run that failed fails the check, whatever its report says", () => {
  expect(runProblem({ status: 0, signal: null, error: undefined })).toBeUndefined()
  expect(runProblem({ status: 1, signal: null, error: undefined })).toBe("Playwright exited 1")
  expect(runProblem({ status: null, signal: "SIGKILL", error: undefined })).toBe("Playwright was killed by SIGKILL")
  expect(runProblem({ status: null, signal: null, error: new Error("spawn pnpm ENOENT") })).toBe("Playwright did not start: spawn pnpm ENOENT")
})
