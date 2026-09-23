import { describe, expect, it } from "@effect/vitest"
import { type Artifact, type Metric, slope, slopeBudgets, verify } from "./soakArtifact.ts"

const fixture = (): Artifact => {
  const samples = Array.from({ length: 5 }, (_, index) => ({
    elapsedMs: 20_000 + index * 10_000,
    cycle: index + 20,
    emitted: (index + 20) * 8,
    connections: (index + 20) * 4,
    compactions: index + 20,
    retainedRows: 32,
    retainedCheckpoints: 1,
    slowSubscribers: 1,
    heapUsed: 10_000_000,
    rss: 30_000_000,
    handles: 5,
    sockets: 2,
    activeReads: 0,
    pendingWrites: 0,
    socketQueuedBytes: 0,
    journalQueued: 1024,
    databaseBytes: 100_000,
    walBytes: 1_000_000
  }))
  return {
    schemaVersion: 1,
    status: "complete",
    runtime: { node: "v26.10.0", platform: "darwin", arch: "arm64" },
    candidate: { head: "a".repeat(40), dirty: true, sourceSha256: "b".repeat(64) },
    workload: { requestedMinutes: 1, warmupMs: 20_000, sampleIntervalMs: 10_000, seed: 20260904 },
    samples,
    slopes: Object.fromEntries(Object.keys(slopeBudgets).map((key) => [key, 0])) as Record<Metric, number>,
    cleanup: { activeReads: 0, pendingWrites: 0, slowSubscribers: 0, sockets: 0 }
  }
}
describe("scheduled soak artifact contract", () => {
  it("accepts complete repeated steady samples and independently computes slope units per minute", () => {
    verify(fixture(), 1)
    const samples = fixture().samples.map((sample) => ({ ...sample, handles: 2 * sample.elapsedMs / 60_000 + 7 }))
    expect(slope(samples, "handles")).toBeCloseTo(2, 12)
  })
  for (const metric of Object.keys(slopeBudgets) as Array<Metric>) {
    it(`refuses retained ${metric} growth even if the artifact claims success`, () => {
      const artifact = fixture()
      artifact.samples = artifact.samples.map((sample) => ({
        ...sample,
        [metric]: sample[metric] +
          2 * slopeBudgets[metric] * sample.elapsedMs / 60_000
      }))
      artifact.slopes[metric] = slope(artifact.samples, metric)
      expect(() => verify(artifact, 1)).toThrow()
    })
  }
  for (
    const corrupt of [
      (value: Artifact) => {
        value.status = "failed"
      },
      (value: Artifact) => {
        value.samples.pop()
      },
      (value: Artifact) => {
        value.slopes.heapUsed = 1
      },
      (value: Artifact) => {
        value.samples[1]!.rss = Number.NaN
      },
      (value: Artifact) => {
        value.cleanup.sockets = 1
      },
      (value: Artifact) => {
        value.samples[2]!.slowSubscribers = 0
      },
      (value: Artifact) => {
        value.candidate.sourceSha256 = "missing"
      },
      (value: Artifact) => {
        value.workload.requestedMinutes = 60
      }
    ]
  ) {
    it("rejects missing, incomplete, forged or unclean evidence", () => {
      const artifact = fixture()
      corrupt(artifact)
      expect(() => verify(artifact, 1)).toThrow()
      expect(() => verify(fixture(), 60)).toThrow()
    })
  }
})
