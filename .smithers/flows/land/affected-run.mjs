#!/usr/bin/env node
/**
 * Runs on a farm host, in apps/mvp of a synced tree: the tests a land owes its change, and nothing else.
 * Prints one SMITHERS_AFFECTED receipt line, base64 JSON, so a client that skips the command can't look like a pass.
 *
 * Request (argv[2], base64 JSON): { labels: target labels to run, tracked?: whether to hand the tests the tree's
 * .smithers inventory,
 * vitest: whether to run apps/mvp's Vitest suite, vitestFiles?: apps/mvp-relative test files to run instead
 * of all of it, shard?: Vitest's `i/n` }.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"

const request = JSON.parse(Buffer.from(process.argv[2], "base64").toString("utf8"))
const app = process.cwd()
const repo = resolve(app, "../..")
const run = (command, args, cwd, env = {}, drop = []) => {
  const environment = { ...process.env, ...env }
  for (const name of drop) delete environment[name]
  return spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: environment })
}
// The farm hands its slot's Postgres to apps/mvp as URLs holding the fixture's password; the workspace's
// declarations refuse a PostgreSQL URL with a password in it, since declared env appears in plans
// (packages/smithers/flows/engine-store/PACKAGE.ts), so index targets run without those and start their own.
const credentialed = (name) => { try { return new URL(process.env[name]).password !== "" } catch { return false } }
const pgUrls = ["SMITHERS_TEST_PG_URL", "SMITHERS_TEST_COMPOSE_PG_URL", "SMITHERS_TEST_PGBOUNCER_URL"].filter(credentialed)
// A package's bin, run by this node directly: through `pnpm exec`, a test process killed after it reported
// comes back as pnpm's exit 1, not as the signal that ended it.
const bin = (from, name, command) => {
  const manifest = createRequire(join(from, "package.json")).resolve(`${name}/package.json`)
  const bins = JSON.parse(readFileSync(manifest, "utf8")).bin
  return join(dirname(manifest), typeof bins === "string" ? bins : bins[command])
}
const runBin = (from, name, command, args, cwd, env, drop) => {
  let path
  try { path = bin(from, name, command) } catch (error) { return { status: null, signal: null, error, stdout: "", stderr: "" } }
  return run(process.execPath, [path, ...args], cwd, env, drop)
}
// Every { label, status, failureDigest? } row, wherever the CLI's summary nests them.
const rows = (value, found = []) => {
  if (Array.isArray(value)) for (const item of value) rows(item, found)
  else if (value && typeof value === "object") {
    if (typeof value.label === "string" && typeof value.status === "string") found.push({ label: value.label, status: value.status, ...typeof value.failureDigest === "string" ? { failureDigest: value.failureDigest } : {} })
    else for (const item of Object.values(value)) rows(item, found)
  }
  return found
}

const result = { targets: { results: [], error: undefined }, vitest: undefined }

// Index targets the land computed from the target index; each must report a result. The results file holds
// one { label, status } row per target the run planned, written whether the run passes or fails.
const labels = request.labels ?? []
const verb = request.verb ?? "test"
if (!["test", "build", "lint", "run"].includes(verb)) throw new Error("Unsupported affected target verb")
if (labels.length) {
  const scratch = mkdtempSync(join(tmpdir(), "affected-targets-"))
  const report = join(scratch, "results.json")
  try {
    // A snapshot has no .jj or .git: hand the tests that need one the source inventory the land sent.
    const inventory = join(scratch, "tracked-source.txt")
    // The tree the land sent holds only tracked files; what the farm adds is node_modules (and build output).
    const walk = (dir) => readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (["node_modules", "dist"].includes(entry.name) ? [] : walk(`${dir}/${entry.name}`)) : [`${dir}/${entry.name}`])
    writeFileSync(inventory, request.tracked ? walk(".smithers").sort().join("\n") + "\n" : "")
    const tested = runBin(repo, "@smthrs/cli", "smthrs", [verb, ...labels, "--results-file", report], repo, { SMITHERS_TEST_SOURCE_MIRROR: "1", SMITHERS_TEST_TRACKED_SOURCE_FILE: inventory }, pgUrls)
    let parsed
    try { parsed = JSON.parse(readFileSync(report, "utf8")) } catch { parsed = undefined }
    result.targets.results = rows(parsed ?? {})
    const output = (tested.stderr + tested.stdout).slice(-2000)
    if (!result.targets.results.length) result.targets.error = `smthrs ${verb} exited ${tested.status} with no per-target results: ${output}`
    // A kill, a spawn error, or a failed exit no failed target accounts for: the results file isn't the run.
    else if (tested.error || tested.signal || (tested.status !== 0 && !result.targets.results.some((row) => row.status === "failed"))) {
      result.targets.error = `smthrs ${verb} ended ${tested.error?.message ?? tested.signal ?? `with exit ${tested.status}`} and no failed target: ${output}`
    }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

// apps/mvp's Vitest suite, which no target in the index declares.
if (request.vitest) {
  const scratch = mkdtempSync(join(tmpdir(), "affected-vitest-"))
  const report = join(scratch, "report.json"), ending = join(scratch, "ending.json"), reporter = join(scratch, "ending-reporter.mjs")
  // The JSON report names files and tests, not errors outside them; this reporter records those and how the
  // run ended, so an unhandled error or a teardown failure can't hide behind a test that fails anyway.
  writeFileSync(reporter, `import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
export default class {
  onTestRunEnd(modules, errors, reason) {
    const text = (error) => String(error?.message ?? error).slice(0, 1000)
    // Each module's own errors and its suites' (a failing beforeAll or afterAll, at any depth), which the JSON
    // report leaves out once a test in the file has failed.
    const suiteErrors = modules.map((module) => ({ moduleId: module.moduleId, errors: [...module.errors(), ...[...module.children.allSuites()].flatMap((suite) => suite.errors())].map(text) }))
    writeFileSync(${JSON.stringify(ending)}, JSON.stringify({ reason, errors: errors.map((error) => String(error?.stack ?? error?.message ?? error).slice(0, 1000)), modules: suiteErrors, skipped: this.skipped ?? [] }))
  }
  onTestCaseResult(test) {
    const result = test.result()
    if (result?.state === "skipped") {
      const note = String(result.note ?? "").trim();
      (this.skipped ??= []).push({ file: test.module.moduleId, name: test.fullName, reasonDigest: note ? createHash("sha256").update(note).digest("hex") : "" })
    }
  }
}
`)
  try {
    const ran = runBin(app, "vitest", "vitest", ["run", "--coverage.enabled=false", "--reporter=json", `--reporter=${reporter}`, `--outputFile.json=${report}`, ...(request.shard ? [`--shard=${request.shard}`] : []), ...(request.vitestFiles ?? [])], app, {})
    let end
    try { end = JSON.parse(readFileSync(ending, "utf8")) } catch { end = undefined }
    let parsed
    try { parsed = JSON.parse(readFileSync(report, "utf8")) } catch { parsed = undefined }
    const relative = (name) => name.startsWith(app + "/") ? name.slice(app.length + 1) : name
    const clean = (text) => String(text ?? "").replaceAll(app, "<app>").replaceAll(repo, "<repo>").replace(/\u001b\[[0-9;]*m/g, "").trim()
    // No report, or a failed run with no files in it, as when a global setup fails: its output says why.
    result.vitest = parsed === undefined || (!parsed.testResults?.length && ran.status !== 0)
      ? { exit: ran.status, files: [], failed: [], stage: "global-setup", error: `vitest exited ${ran.status} and ran no test files (report ${JSON.stringify({ ...parsed, testResults: undefined }).slice(0, 600)}; ending ${JSON.stringify(end ?? null).slice(0, 1500)}): ${(ran.stderr + ran.stdout).slice(-4000)}` }
      : {
        exit: ran.status,
        files: parsed.testResults.map((file) => relative(file.name)).sort(),
        failed: parsed.testResults.flatMap((file) => {
          // Tests that share a title are told apart by their place among those that do, so a second case
          // failing beside a first that already failed on the base is its own failure.
          const counts = new Map(), seen = new Map()
          for (const test of file.assertionResults) counts.set(test.fullName, (counts.get(test.fullName) ?? 0) + 1)
          const failed = file.assertionResults.flatMap((test) => {
            const nth = (seen.get(test.fullName) ?? 0) + 1
            seen.set(test.fullName, nth)
            if (test.status !== "failed") return []
            const name = counts.get(test.fullName) > 1 ? `${test.fullName} [${nth} of ${counts.get(test.fullName)}]` : test.fullName
          // Only reserved-looking assertion names need a discriminator; ordinary receipt shapes stay stable.
          return [{ file: relative(file.name), name, .../^\((?:ran no tests|the file failed|skipped reason)/.test(name) ? { assertion: true } : {} }]
          })
          // A file's own error, from collection or a suite hook, is a failure of its own beside any failed test,
          // named by a hash of its text: a different error on the base is a different failure. A failed file with
          // no failed test and no error to name can't be shown to fail the same way, so the base can't excuse it.
          const message = clean(file.message)
          if (message) failed.push({ file: relative(file.name), name: `(the file failed: ${createHash("sha256").update(message).digest("hex").slice(0, 16)}) ${message.split("\n")[0].slice(0, 200)}` })
          else if (!failed.length && file.status === "failed") failed.push({ file: relative(file.name), name: "(the file failed, with no error)", unexcused: true })
          return failed
        })
      }
    // Module and suite errors the reporter saw, each its own failure by the hash of its text, beside the
    // file's tests; one the JSON report already named counts once.
    if (!result.vitest.error) for (const module of end?.modules ?? []) {
      for (const error of module.errors) {
        const message = clean(error)
        const name = `(the file failed: ${createHash("sha256").update(message).digest("hex").slice(0, 16)}) ${message.split("\n")[0].slice(0, 200)}`
        if (message && !result.vitest.failed.some((test) => test.file === relative(module.moduleId) && test.name === name && test.assertion !== true)) result.vitest.failed.push({ file: relative(module.moduleId), name })
      }
    }
    const failedTests = result.vitest.failed.length
    // A skipped file counts as an identity only when Vitest recorded a nonempty reason for every skip. The
    // land compares these identities on the base and includes matching files in its excused receipt.
    if (!result.vitest.error) for (const file of parsed.testResults) {
      const tests = file.assertionResults
      if (tests.length && tests.every((test) => test.status === "skipped")) {
        const skips = (end?.skipped ?? []).filter((test) => relative(test.file) === relative(file.name))
        const reasons = skips.map((test) => String(test.reasonDigest ?? "").trim())
        if (skips.length === tests.length && JSON.stringify(skips.map((test) => test.name).sort()) === JSON.stringify(tests.map((test) => test.fullName).sort()) && reasons.every((reason) => /^[a-f0-9]{64}$/.test(reason))) {
          // Compare the whole file's test/reason multiset, including multiplicity. An extra or changed
          // reason on either tree must not be excused by a reason the two files happen to share.
          const reason = createHash("sha256").update(JSON.stringify(skips.map((test) => [test.name, test.reasonDigest]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest("hex")
          result.vitest.failed.push({ file: relative(file.name), name: `(skipped reason sha256:${reason})`, skipped: true })
        }
      }
    }
    // A file that ran no test and provided no matching skip reason didn't run: it stands as an unexcusable failure.
    if (!result.vitest.error) for (const file of parsed.testResults) {
      if (!file.assertionResults.some((test) => test.status === "passed" || test.status === "failed") && !result.vitest.failed.some((test) => test.file === relative(file.name) && test.skipped)) result.vitest.failed.push({ file: relative(file.name), name: "(ran no tests)", unexcused: true })
    }
    // A kill or a spawn error ends the run, whatever its report says; a failed exit with no failed test is a
    // failure no test names: an unhandled error or a teardown.
    const output = (ran.stderr + ran.stdout).slice(-4000)
    const broke = () => {
      if (ran.error || ran.signal) return `vitest ended ${ran.error?.message ?? ran.signal}: ${output}`
      if (end === undefined) return `vitest exited ${ran.status} without reaching the end of its run: ${output}`
      if (end.errors.length) return `vitest caught ${end.errors.length} errors outside any test:\n${end.errors.join("\n")}`
      if (end.reason === "interrupted") return `vitest's run was interrupted: ${output}`
      if (ran.status !== 0 && !failedTests) return `vitest exited ${ran.status} with no failed test: ${output}`
    }
    result.vitest.error ??= broke()
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

console.log(`SMITHERS_AFFECTED ${Buffer.from(JSON.stringify(result)).toString("base64")}`)
