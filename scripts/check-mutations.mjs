/** Vite-transform mutation gate. Baselines, loaded mutation sites and assertion failures are all required. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { mutants as manifest, exclusions } from "./mutations/manifest.mjs"
import { isMain, repoRoot as root } from "./workspace-packages.mjs"

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function verifyOutcome(result, baseline, mutant) {
  assert.equal(result.error, undefined, `${mutant.id}: runner failed to start`)
  assert.equal(result.signal, null, `${mutant.id}: interrupted runner`)
  assert.equal(result.report.testResults.filter((file) => file.status === "failed").length, baseline ? 0 : 1, `${mutant.id}: unexpected failing files`)
  assert.ok(result.report.testResults.every((file) => !file.message), `${mutant.id}: infrastructure error`)
  const assertions = result.report.testResults.flatMap((file) => file.assertionResults)
  const executed = assertions.filter((entry) => ["passed", "failed"].includes(entry.status))
  assert.ok(executed.length > 0, `${mutant.id}: selected no assertions`)
  if (baseline) {
    assert.equal(result.status, 0, `${mutant.id}: baseline failed`)
    assert.equal(result.report.success, true)
    assert.ok(executed.every((entry) => entry.status === "passed"))
  } else {
    assert.equal(result.status, 1, `${mutant.id}: mutant survived or runner failed`)
    assert.equal(result.report.success, false)
    assert.equal(result.applied, true, `${mutant.id}: mutation was never loaded`)
    const failed = executed.filter((entry) => entry.status === "failed")
    assert.ok(failed.length > 0)
    for (const entry of failed) {
      assert.ok(entry.fullName.includes(mutant.test), `${mutant.id}: unrelated failure ${entry.fullName}`)
      assert.ok(entry.failureMessages.some((message) => /AssertionError/.test(message)), `${mutant.id}: not a behavioral assertion failure`)
    }
  }
  return executed.map(({ fullName, status }) => ({ fullName, status }))
}

export function runMutations(artifacts = mkdtempSync(join(tmpdir(), "smithers-mutations-")), mutants = manifest) {
  artifacts = resolve(artifacts)
  mkdirSync(artifacts, { recursive: true })
  assert.equal(readdirSync(artifacts).length, 0, "Use a new artifact directory; prior evidence is immutable")
  const before = new Map(mutants.map((mutant) => { const path = resolve(root, mutant.package, mutant.source); return [path, hash(path)] }))
  const results = []
  try {
    for (const mutant of mutants) {
      const cwd = resolve(root, mutant.package)
      const source = resolve(cwd, mutant.source)
      assert.equal(readFileSync(source, "utf8").split(mutant.original).length, 2, `${mutant.id}: stale or ambiguous mutation site`)
      const require = createRequire(join(cwd, "package.json"))
      const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs")
      for (const baseline of [true, false]) {
        const name = `${mutant.id}-${baseline ? "baseline" : "mutant"}`
        const config = join(artifacts, `${name}.config.mjs`)
        const reportPath = join(artifacts, `${name}.json`)
        const marker = join(artifacts, `${name}.applied`)
        writeFileSync(config, `import { writeFileSync } from 'node:fs';
export default {
  plugins: ${baseline ? "[]" : `[{ name: ${JSON.stringify(mutant.id)}, enforce: 'pre', transform(code, id) {
    if (id.split('?')[0] !== ${JSON.stringify(source)}) return null;
    const original = ${JSON.stringify(mutant.original)};
    if (code.split(original).length !== 2) throw new Error('Mutation site must occur exactly once');
    writeFileSync(${JSON.stringify(marker)}, 'applied');
    return code.replace(original, ${JSON.stringify(mutant.replacement)});
  }}]`},
  test: { environment: 'node', maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000, coverage: { enabled: false } }
};\n`)
        const ran = spawnSync(process.execPath, [vitest, "run", mutant.file, "--config", config,
          "--testNamePattern", escapeRegex(mutant.test), "--reporter=json", `--outputFile=${reportPath}`], {
          cwd, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024
        })
        const log = join(artifacts, `${name}.log`)
        writeFileSync(log, `${ran.stdout ?? ""}${ran.stderr ?? ""}`)
        const ending = [ran.error?.message, ran.signal && `signal ${ran.signal}`, ran.status !== null && `exit status ${ran.status}`].filter(Boolean).join(", ")
        assert.ok(!ran.error && !ran.signal && existsSync(reportPath), `${name}: runner ended by ${ending} without a complete report; log ${log}`)
        const report = JSON.parse(readFileSync(reportPath, "utf8"))
        const assertions = verifyOutcome({ ...ran, report, applied: existsSync(marker) }, baseline, mutant)
        if (!baseline) results.push({ ...mutant, status: "killed", assertions })
      }
      console.log(`${mutant.id}: killed`)
    }
    for (const [path, digest] of before) assert.equal(hash(path), digest, `Source changed during mutation run: ${path}`)
    const summary = { schemaVersion: 1, status: "passed", node: process.version, platform: process.platform,
      sources: [...before].map(([path, sha256]) => ({ path, sha256 })), results, exclusions }
    writeFileSync(join(artifacts, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`Mutation evidence: ${artifacts}`)
    return summary
  } catch (error) {
    writeFileSync(join(artifacts, "failure.json"), `${JSON.stringify({ status: "failed", node: process.version, message: String(error), results }, null, 2)}\n`)
    throw error
  }
}

if (isMain(import.meta)) runMutations(process.env.SMITHERS_MUTATION_ARTIFACT_DIR)
