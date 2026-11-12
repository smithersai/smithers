import assert from "node:assert/strict"

/**
 * The Node releases a soak receipt may come from: the repository's pinned
 * `.node-version` and the rows of the scheduled `sync-long-soak` matrix. The
 * workload refuses any other runtime before its first cycle.
 */
export const nodeReleases = ["26.4.0", "26.5.0", "26.10.0"] as const
export const isSupportedNode = (version: string): boolean => nodeReleases.some((release) => version === `v${release}`)

export const slopeBudgets = {
  heapUsed: 1024 * 1024,
  rss: 4 * 1024 * 1024,
  handles: 0.5,
  sockets: 0.5,
  activeReads: 1,
  socketQueuedBytes: 64 * 1024,
  journalQueued: 1,
  databaseBytes: 1024 * 1024,
  walBytes: 1024 * 1024
} as const
export type Metric = keyof typeof slopeBudgets
export interface Sample extends Record<Metric, number> {
  elapsedMs: number
  /** Not a slope budget: every sample must report zero. */
  pendingWrites: number
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
/** What the schedule that produced a receipt states about it. */
export interface Expectation {
  /** The receipt must cover at least this many minutes. */
  minimumMinutes: number
  /** The producer's seed, when the schedule fixes one. */
  seed?: number
  /** The scheduled Node release, such as `26.10.0`, when the schedule fixes one. */
  node?: string
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

/**
 * The one verifier of a soak receipt. The workload runs it before it exits,
 * and CI runs it again, independently, after the workload command exits.
 */
export const verify = (artifact: Artifact, expected: Expectation): void => {
  const fail = "Incomplete sync soak evidence"
  assert.equal(artifact.schemaVersion, 1, fail)
  assert.equal(artifact.status, "complete", fail)
  assert.equal(artifact.failure, undefined, `${fail}: failure recorded`)
  assert.ok(
    isSupportedNode(artifact.runtime.node),
    `${fail}: ${artifact.runtime.node} is not a supported Node runtime (v${nodeReleases.join(", v")})`
  )
  if (expected.node !== undefined) assert.equal(artifact.runtime.node, `v${expected.node}`, `${fail}: runtime mismatch`)
  assert.ok(artifact.runtime.platform.length > 0 && artifact.runtime.arch.length > 0, fail)
  assert.match(artifact.candidate.head, /^[a-f0-9]{40}$/)
  assert.equal(typeof artifact.candidate.dirty, "boolean")
  assert.match(artifact.candidate.sourceSha256, /^[a-f0-9]{64}$/)
  const workload = artifact.workload
  assert.ok(Number.isFinite(expected.minimumMinutes) && expected.minimumMinutes >= 1)
  assert.ok(
    Number.isFinite(workload.requestedMinutes) && workload.requestedMinutes >= 1 && workload.requestedMinutes <= 720,
    `${fail}: requested minutes must be within 1..720`
  )
  assert.ok(workload.requestedMinutes >= expected.minimumMinutes, `${fail}: minutes mismatch`)
  assert.equal(workload.seed, 20260904, `${fail}: producer's deterministic seed`)
  if (expected.seed !== undefined) assert.equal(workload.seed, expected.seed, `${fail}: seed mismatch`)
  assert.equal(workload.warmupMs, 20_000)
  assert.equal(workload.sampleIntervalMs, 10_000)
  assert.ok(
    Array.isArray(artifact.samples) && artifact.samples.length >= 5,
    `${fail}: at least five post-warmup samples`
  )
  let previousTime = workload.warmupMs - 1
  let previousCycle = 0
  let previousEmitted = 0
  for (const sample of artifact.samples) {
    for (const [field, value] of Object.entries(sample)) {
      const counted = field === "elapsedMs" ? Number.isFinite(value) : Number.isSafeInteger(value)
      assert.ok(counted && value >= 0, `${fail}: invalid ${field}`)
    }
    assert.ok(sample.elapsedMs > previousTime, `${fail}: sample order`)
    assert.ok(sample.elapsedMs - previousTime <= 30_000, `${fail}: missing sampling interval`)
    assert.ok(sample.cycle > previousCycle, `${fail}: stopped cycling`)
    assert.ok(sample.emitted > previousEmitted, `${fail}: stopped publishing`)
    assert.ok(sample.connections >= sample.cycle * 4 && sample.emitted >= sample.cycle * 8, `${fail}: no useful work`)
    assert.ok(sample.compactions > 0)
    assert.ok(sample.retainedRows <= 40)
    assert.equal(sample.retainedCheckpoints, 1)
    assert.equal(sample.slowSubscribers, 1)
    assert.equal(sample.pendingWrites, 0, `${fail}: pending work after quiescence`)
    assert.ok(sample.journalQueued <= 1024)
    previousTime = sample.elapsedMs
    previousCycle = sample.cycle
    previousEmitted = sample.emitted
  }
  assert.ok(previousTime >= expected.minimumMinutes * 60_000, `${fail}: truncated samples`)
  assert.ok(previousTime >= workload.requestedMinutes * 60_000, `${fail}: truncated samples`)
  for (const metric of Object.keys(slopeBudgets) as Array<Metric>) {
    const measured = slope(artifact.samples, metric)
    assert.ok(Number.isFinite(measured))
    assert.ok(Math.abs(measured - artifact.slopes[metric]) < 0.000001, `${fail}: incorrect ${metric} slope`)
    assert.ok(measured <= slopeBudgets[metric], `${metric} growth ${measured}/minute exceeds ${slopeBudgets[metric]}`)
  }
  assert.deepEqual(
    artifact.cleanup,
    { activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 },
    `${fail}: leaked owned resources`
  )
}
