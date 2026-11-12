import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import {
  type Artifact,
  isSupportedNode,
  type Metric,
  nodeReleases,
  slope,
  slopeBudgets,
  verify
} from "./soakArtifact.ts"

const pinnedNode = readFileSync(new URL("../../../../../.node-version", import.meta.url), "utf8").trim()

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
    journalQueued: 64,
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
    verify(fixture(), { minimumMinutes: 1 })
    const samples = fixture().samples.map((sample) => ({ ...sample, handles: 2 * sample.elapsedMs / 60_000 + 7 }))
    expect(slope(samples, "handles")).toBeCloseTo(2, 12)
  })
  it("accepts a receipt from the repository's pinned Node and refuses any other runtime", () => {
    expect(nodeReleases).toContain(pinnedNode)
    expect(isSupportedNode(`v${pinnedNode}`)).toBe(true)
    const artifact = fixture()
    artifact.runtime.node = `v${pinnedNode}`
    verify(artifact, { minimumMinutes: 1 })
    for (const node of ["v26.11.0", "26.10.0", "v22.19.0", ""]) {
      expect(isSupportedNode(node)).toBe(false)
      artifact.runtime.node = node
      expect(() => verify(artifact, { minimumMinutes: 1 })).toThrow(/not a supported Node runtime/)
    }
  })
  it("holds the receipt to the schedule's row, seed and minutes when they are stated", () => {
    verify(fixture(), { minimumMinutes: 1, seed: 20260904, node: "26.10.0" })
    expect(() => verify(fixture(), { minimumMinutes: 1, node: "26.4.0" })).toThrow(/runtime mismatch/)
    expect(() => verify(fixture(), { minimumMinutes: 1, seed: 8 })).toThrow(/seed mismatch/)
    expect(() => verify(fixture(), { minimumMinutes: 4 })).toThrow(/minutes mismatch/)
    expect(() => verify(fixture(), { minimumMinutes: 0 })).toThrow()
  })
  for (const metric of Object.keys(slopeBudgets) as Array<Metric>) {
    it(`refuses retained ${metric} growth even if the artifact claims success`, () => {
      const artifact = fixture()
      // Counts stay whole: grow by at least twice the budget every sampling interval.
      artifact.samples = artifact.samples.map((sample) => ({
        ...sample,
        [metric]: sample[metric] + Math.ceil(2 * slopeBudgets[metric]) * (sample.elapsedMs / 10_000)
      }))
      artifact.slopes[metric] = slope(artifact.samples, metric)
      expect(() => verify(artifact, { minimumMinutes: 1 })).toThrow(new RegExp(`^${metric} growth .* exceeds `))
    })
  }
  for (
    const [corrupt, reason] of [
      [(value: Artifact) => {
        value.status = "failed"
      }, /./],
      [(value: Artifact) => {
        value.failure = "incomplete: workload has not finished"
      }, /failure recorded/],
      [(value: Artifact) => {
        value.samples.pop()
      }, /at least five post-warmup samples/],
      [(value: Artifact) => {
        value.slopes.heapUsed = 1
      }, /incorrect heapUsed slope/],
      [(value: Artifact) => {
        value.samples[1]!.rss = Number.NaN
      }, /invalid rss/],
      [(value: Artifact) => {
        value.samples[1]!.heapUsed = 10_000_000.5
      }, /invalid heapUsed/],
      [(value: Artifact) => {
        value.samples[0]!.cycle = 0
      }, /stopped cycling/],
      [(value: Artifact) => {
        value.samples[2]!.emitted = value.samples[1]!.emitted
      }, /stopped publishing/],
      [(value: Artifact) => {
        value.samples[2]!.connections = 1
      }, /no useful work/],
      [(value: Artifact) => {
        value.cleanup.sockets = 1
      }, /leaked owned resources/],
      [(value: Artifact) => {
        value.samples[2]!.slowSubscribers = 0
      }, /./],
      [(value: Artifact) => {
        value.samples[2]!.pendingWrites = 1
      }, /pending work after quiescence/],
      [(value: Artifact) => {
        value.samples[2]!.journalQueued = 1025
      }, /./],
      [(value: Artifact) => {
        value.candidate.sourceSha256 = "missing"
      }, /./],
      [(value: Artifact) => {
        value.workload.requestedMinutes = 60
      }, /truncated samples/],
      [(value: Artifact) => {
        value.workload.requestedMinutes = 721
      }, /within 1\.\.720/]
    ] as const
  ) {
    it("rejects missing, incomplete, forged or unclean evidence", () => {
      const artifact = fixture()
      corrupt(artifact)
      expect(() => verify(artifact, { minimumMinutes: 1 })).toThrow(reason)
      expect(() => verify(fixture(), { minimumMinutes: 60 })).toThrow(/minutes mismatch/)
    })
  }
})
