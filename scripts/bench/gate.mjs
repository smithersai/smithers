/** Counter-based PR gate and separately retained scheduled timing observations. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { resources, runCorpus } from "./corpus.mjs"
import { isMain } from "../workspace-packages.mjs"

export function compare(results, baseline) {
  assert.deepEqual(results.map((row) => row.id).sort(), baseline.cases.map((row) => row.id).sort(), "fixture roster changed")
  for (const row of results) {
    const expected = baseline.cases.find((entry) => entry.id === row.id)
    assert.equal(row.validated, true, `${row.id}: unvalidated output`)
    assert.equal(row.size, expected.size, `${row.id}: reduced fixture`)
    assert.equal(row.outputDigest, expected.outputDigest, `${row.id}: output changed`)
    assert.deepEqual(Object.keys(row.counts).sort(), Object.keys(expected.counts).sort(), `${row.id}: missing cost metric`)
    for (const [key, count] of Object.entries(row.counts)) {
      assert.ok(Number.isSafeInteger(count) && count >= 0, `${row.id}/${key}: invalid count`)
      assert.ok(count <= Math.ceil(expected.counts[key] * (1 + baseline.maxIncrease)),
        `${row.id}/${key}: ${count} exceeds baseline ${expected.counts[key]} + ${baseline.maxIncrease * 100}%`)
    }
  }
}

export async function benchmark({ output = join(tmpdir(), `smithers-benchmark-${process.pid}`), measure = false, candidate = false } = {}) {
  output = resolve(output)
  mkdirSync(output, { recursive: true })
  assert.equal(readdirSync(output).length, 0, "Use a fresh output directory")
  const baselinePath = new URL("./baseline.json", import.meta.url)
  const baseline = candidate ? null : JSON.parse(readFileSync(baselinePath, "utf8"))
  const repetitions = measure ? 3 : 1
  const samples = []
  const start = resources()
  try {
    // Cold: first process execution with fresh databases. Warmup: one discarded
    // corpus. Warm: repeated code/JIT, each fixture still uses fresh storage.
    const cold = measure ? await runCorpus({ measure }) : null
    if (measure) await runCorpus({ measure })
    for (let repetition = 0; repetition < repetitions; repetition++) {
      globalThis.gc?.()
      const results = await runCorpus({ measure })
      if (baseline) compare(results, baseline)
      globalThis.gc?.()
      samples.push({ repetition, resources: resources(), results })
    }
    const summary = { schemaVersion: 1, status: "passed", mode: measure ? "scheduled-measurement" : candidate ? "baseline-candidate" : "pr-counter-gate",
      node: process.version, platform: process.platform, arch: process.arch, gcExposed: !!globalThis.gc,
      baselineSha256: baseline ? createHash("sha256").update(readFileSync(baselinePath)).digest("hex") : null,
      start, cold, samples, finish: resources() }
    writeFileSync(join(output, "result.json"), `${JSON.stringify(summary, null, 2)}\n`)
    console.log(`${summary.mode}: ${samples[0].results.length} fixtures passed; ${output}/result.json`)
    return summary
  } catch (error) {
    writeFileSync(join(output, "failure.json"), `${JSON.stringify({ status: "failed", node: process.version, message: String(error), samples }, null, 2)}\n`)
    throw error
  }
}

if (isMain(import.meta)) {
  await benchmark({ output: process.env.SMITHERS_BENCH_ARTIFACT_DIR, measure: process.argv.includes("--measure"), candidate: process.argv.includes("--candidate") })
}
