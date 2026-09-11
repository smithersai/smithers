/** Refuse incomplete sync soak evidence. Scheduling a tier does not prove it ran. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { isMain } from "./workspace-packages.mjs"

export function slope(samples, field) {
  const xs = samples.map((sample) => sample.elapsedMs / 60_000)
  const ys = samples.map((sample) => sample[field])
  const xbar = xs.reduce((a, b) => a + b, 0) / xs.length
  const ybar = ys.reduce((a, b) => a + b, 0) / ys.length
  return ys.reduce((sum, y, i) => sum + (xs[i] - xbar) * (y - ybar), 0) /
    xs.reduce((sum, x) => sum + (x - xbar) ** 2, 0)
}

export function verifySoak(artifact, { minutes, seed, node } = {}) {
  const fail = "Incomplete sync soak evidence"
  assert.equal(artifact.schemaVersion, 1, fail)
  assert.equal(artifact.status, "complete", fail)
  assert.equal(artifact.failure, undefined, fail)
  assert.match(artifact.runtime.node, /^v(?:22\.19\.0|24\.18\.0)$/, `${fail}: supported Node runtime`)
  if (node !== undefined) assert.equal(artifact.runtime.node, `v${node}`, `${fail}: runtime mismatch`)
  assert.ok(artifact.runtime.platform.length > 0 && artifact.runtime.arch.length > 0, fail)
  assert.match(artifact.candidate.head, /^[a-f0-9]{40}$/)
  assert.match(artifact.candidate.sourceSha256, /^[a-f0-9]{64}$/)
  assert.equal(typeof artifact.candidate.dirty, "boolean")
  const workload = artifact.workload
  assert.ok(Number.isFinite(workload.requestedMinutes) && workload.requestedMinutes >= 1 && workload.requestedMinutes <= 720, fail)
  assert.equal(workload.seed, 20260904, `${fail}: producer's deterministic seed`)
  assert.equal(workload.warmupMs, 20_000)
  assert.equal(workload.sampleIntervalMs, 10_000)
  if (minutes !== undefined) assert.equal(workload.requestedMinutes, minutes, `${fail}: minutes mismatch`)
  if (seed !== undefined) assert.equal(workload.seed, seed, `${fail}: seed mismatch`)
  assert.ok(Array.isArray(artifact.samples) && artifact.samples.length >= 5, `${fail}: at least five post-warmup samples`)
  const budgets = { heapUsed: 1024 * 1024, rss: 4 * 1024 * 1024, handles: 0.5, sockets: 0.5,
    activeReads: 1, pendingWrites: 1, socketQueuedBytes: 64 * 1024, journalQueued: 1,
    databaseBytes: 1024 * 1024, walBytes: 1024 * 1024 }
  let prior = workload.warmupMs - 1
  for (const sample of artifact.samples) {
    assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs > prior && sample.elapsedMs - prior <= 30_000, `${fail}: sample order or missing interval`)
    prior = sample.elapsedMs
    for (const field of [...Object.keys(budgets), "cycle", "emitted", "connections", "compactions", "retainedRows", "retainedCheckpoints", "slowSubscribers"]) {
      assert.ok(Number.isSafeInteger(sample[field]) && sample[field] >= 0, `${fail}: invalid ${field}`)
    }
    assert.ok(sample.cycle > 0 && sample.emitted >= sample.cycle * 8 && sample.connections >= sample.cycle * 4, `${fail}: no useful work`)
    assert.ok(sample.compactions > 0 && sample.retainedRows <= 40 && sample.journalQueued <= 1024)
    assert.equal(sample.retainedCheckpoints, 1)
    assert.equal(sample.slowSubscribers, 1)
    assert.equal(sample.pendingWrites, 0, `${fail}: pending work after quiescence`)
  }
  assert.ok(prior >= workload.requestedMinutes * 60_000, `${fail}: truncated samples`)
  for (let index = 1; index < artifact.samples.length; index++) {
    assert.ok(artifact.samples[index].cycle > artifact.samples[index - 1].cycle, `${fail}: stopped cycling`)
    assert.ok(artifact.samples[index].emitted > artifact.samples[index - 1].emitted, `${fail}: stopped publishing`)
  }
  assert.deepEqual(artifact.cleanup, { activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 }, `${fail}: leaked owned resources`)
  const growth = Object.fromEntries(Object.keys(budgets).map((field) => [field, slope(artifact.samples, field)]))
  for (const [field, measured] of Object.entries(growth)) {
    assert.ok(Number.isFinite(measured) && Math.abs(measured - artifact.slopes[field]) < 0.000001, `${fail}: incorrect ${field} slope`)
    assert.ok(measured <= budgets[field], `${fail}: ${field} growth exceeds ${budgets[field]}/minute`)
  }
  return { minutes: workload.requestedMinutes, seed: workload.seed, samples: artifact.samples.length, growth }
}

if (isMain(import.meta)) {
  const path = process.argv[2]
  assert.ok(path, "usage: node scripts/check-soak-campaign.mjs <artifact.json>")
  console.log(JSON.stringify(verifySoak(JSON.parse(readFileSync(path, "utf8")), {
    minutes: process.env.SMITHERS_SOAK_MINUTES === undefined ? undefined : Number(process.env.SMITHERS_SOAK_MINUTES),
    seed: process.env.SMITHERS_SOAK_SEED === undefined ? undefined : Number(process.env.SMITHERS_SOAK_SEED),
    node: process.env.SMITHERS_SOAK_NODE
  })))
}
