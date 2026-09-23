import assert from "node:assert/strict"

export const slopeBudgets = {
  heapUsed: 1024 * 1024,
  rss: 4 * 1024 * 1024,
  handles: 0.5,
  sockets: 0.5,
  activeReads: 1,
  pendingWrites: 1,
  socketQueuedBytes: 64 * 1024,
  journalQueued: 1,
  databaseBytes: 1024 * 1024,
  walBytes: 1024 * 1024
} as const
export type Metric = keyof typeof slopeBudgets
export interface Sample extends Record<Metric, number> {
  elapsedMs: number
  cycle: number
  emitted: number
  connections: number
  compactions: number
  retainedRows: number
  retainedCheckpoints: number
  slowSubscribers: number
}
export interface Artifact {
  schemaVersion: 1
  status: "complete" | "failed"
  runtime: { node: string; platform: string; arch: string }
  candidate: { head: string; dirty: boolean; sourceSha256: string }
  workload: { requestedMinutes: number; warmupMs: number; sampleIntervalMs: number; seed: number }
  samples: Array<Sample>
  slopes: Record<Metric, number>
  cleanup: { activeReads: number; pendingWrites: number; slowSubscribers: number; sockets: number }
  failure?: string
}
export const slope = (samples: ReadonlyArray<Sample>, metric: Metric): number => {
  const meanTime = samples.reduce((total, sample) => total + sample.elapsedMs / 60_000, 0) / samples.length
  const meanValue = samples.reduce((total, sample) => total + sample[metric], 0) / samples.length
  return samples.reduce(
    (total, sample) => total + (sample.elapsedMs / 60_000 - meanTime) * (sample[metric] - meanValue),
    0
  ) /
    samples.reduce((total, sample) => total + (sample.elapsedMs / 60_000 - meanTime) ** 2, 0)
}

/** CI must independently verify the artifact after the workload command exits. */
export const verify = (artifact: Artifact, minimumMinutes: number): void => {
  assert.equal(artifact.schemaVersion, 1)
  assert.equal(artifact.status, "complete")
  assert.match(artifact.runtime.node, /^v(?:26\.4\.0|26\.10\.0)$/)
  assert.ok(artifact.runtime.platform.length > 0 && artifact.runtime.arch.length > 0)
  assert.match(artifact.candidate.head, /^[a-f0-9]{40}$/)
  assert.equal(typeof artifact.candidate.dirty, "boolean")
  assert.match(artifact.candidate.sourceSha256, /^[a-f0-9]{64}$/)
  assert.ok(Number.isFinite(minimumMinutes) && minimumMinutes >= 1)
  assert.ok(artifact.workload.requestedMinutes >= minimumMinutes)
  assert.equal(artifact.workload.seed, 20260904)
  assert.equal(artifact.workload.warmupMs, 20_000)
  assert.equal(artifact.workload.sampleIntervalMs, 10_000)
  assert.ok(artifact.samples.length >= 5)
  let previousTime = artifact.workload.warmupMs - 1
  let previousCycle = -1
  for (const sample of artifact.samples) {
    for (const value of Object.values(sample)) assert.ok(Number.isFinite(value) && value >= 0)
    assert.ok(sample.elapsedMs > previousTime)
    assert.ok(sample.elapsedMs - previousTime <= 30_000, "missing sampling interval")
    assert.ok(sample.cycle > previousCycle)
    assert.ok(sample.connections >= sample.cycle * 4)
    assert.ok(sample.emitted >= sample.cycle * 8)
    assert.ok(sample.compactions > 0)
    assert.ok(sample.retainedRows <= 40)
    assert.equal(sample.retainedCheckpoints, 1)
    assert.equal(sample.slowSubscribers, 1)
    assert.equal(sample.pendingWrites, 0)
    assert.ok(sample.journalQueued <= 1024)
    previousTime = sample.elapsedMs
    previousCycle = sample.cycle
  }
  assert.ok(previousTime >= minimumMinutes * 60_000)
  assert.ok(previousTime >= artifact.workload.requestedMinutes * 60_000)
  for (const metric of Object.keys(slopeBudgets) as Array<Metric>) {
    const measured = slope(artifact.samples, metric)
    assert.ok(Number.isFinite(measured))
    assert.ok(Math.abs(measured - artifact.slopes[metric]) < 0.000001, `incorrect ${metric} slope`)
    assert.ok(measured <= slopeBudgets[metric], `${metric} growth ${measured}/minute exceeds ${slopeBudgets[metric]}`)
  }
  assert.deepEqual(artifact.cleanup, { activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 })
}
