/**
 * The fencing counters: claim, activation, heartbeat, and transition outcomes
 * land in the registry the caller provided, keyed by operation and outcome.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as ObservabilityMetric from "@smthrs/observability/Metric"
import { Clock, Effect, Exit, Metric } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import type { LivenessEvidence, OwnerId } from "../src/Ownership.ts"
import { type RunRow, type RunSnapshot, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"
import * as RunStoreMetrics from "../src/RunStoreMetrics.ts"

const migrated = <A, E>(effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer()),
    Effect.provideService(Metric.MetricRegistry, new Map())
  )

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-a", pid: 202, nonce: "owner-b" }

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

describe("RunStoreMetrics", () => {
  it.effect("pins every outcome label and every transition target attribute", () =>
    Effect.gen(function*() {
      expect(Object.keys(RunStoreMetrics.claim)).toEqual([
        "Claimed",
        "NotFound",
        "AlreadyClaimed",
        "HeartbeatFresh",
        "SnapshotChanged"
      ])
      expect(Object.keys(RunStoreMetrics.claimAndOwn)).toEqual([
        "Activated",
        "NotFound",
        "AlreadyClaimed",
        "HeartbeatFresh",
        "SnapshotChanged",
        "EvidenceRequired"
      ])
      expect(Object.keys(RunStoreMetrics.activate)).toEqual(["Activated", "ClaimLost", "SnapshotChanged"])
      expect(Object.keys(RunStoreMetrics.recoverClaim)).toEqual([
        "Recovered",
        "NotFound",
        "ClaimFresh",
        "ClaimChanged",
        "LivenessUnconfirmed"
      ])
      expect(Object.keys(RunStoreMetrics.abandonClaim)).toEqual(["Abandoned", "ClaimLost"])
      expect(Object.keys(RunStoreMetrics.steal)).toEqual([
        "Claimed",
        "NotFound",
        "AlreadyClaimed",
        "HeartbeatFresh",
        "SnapshotChanged",
        "LivenessUnconfirmed"
      ])
      expect(Object.keys(RunStoreMetrics.heartbeat)).toEqual(["Updated", "FenceLost", "NotFound"])
      expect(Object.keys(RunStoreMetrics.transition)).toEqual([
        "Transitioned",
        "FenceLost",
        "NotFound",
        "GuardFailed"
      ])

      const claims = [
        [RunStoreMetrics.claim.Claimed, { op: "claim", outcome: "claimed" }],
        [RunStoreMetrics.claim.NotFound, { op: "claim", outcome: "not_found" }],
        [RunStoreMetrics.claim.AlreadyClaimed, { op: "claim", outcome: "already_claimed" }],
        [RunStoreMetrics.claim.HeartbeatFresh, { op: "claim", outcome: "heartbeat_fresh" }],
        [RunStoreMetrics.claim.SnapshotChanged, { op: "claim", outcome: "snapshot_changed" }],
        [RunStoreMetrics.claimAndOwn.Activated, { op: "claim_and_own", outcome: "activated" }],
        [RunStoreMetrics.claimAndOwn.NotFound, { op: "claim_and_own", outcome: "not_found" }],
        [RunStoreMetrics.claimAndOwn.AlreadyClaimed, { op: "claim_and_own", outcome: "already_claimed" }],
        [RunStoreMetrics.claimAndOwn.HeartbeatFresh, { op: "claim_and_own", outcome: "heartbeat_fresh" }],
        [RunStoreMetrics.claimAndOwn.SnapshotChanged, { op: "claim_and_own", outcome: "snapshot_changed" }],
        [RunStoreMetrics.claimAndOwn.EvidenceRequired, { op: "claim_and_own", outcome: "evidence_required" }],
        [RunStoreMetrics.activate.Activated, { op: "activate", outcome: "activated" }],
        [RunStoreMetrics.activate.ClaimLost, { op: "activate", outcome: "claim_lost" }],
        [RunStoreMetrics.activate.SnapshotChanged, { op: "activate", outcome: "snapshot_changed" }],
        [RunStoreMetrics.recoverClaim.Recovered, { op: "recover_claim", outcome: "recovered" }],
        [RunStoreMetrics.recoverClaim.NotFound, { op: "recover_claim", outcome: "not_found" }],
        [RunStoreMetrics.recoverClaim.ClaimFresh, { op: "recover_claim", outcome: "claim_fresh" }],
        [RunStoreMetrics.recoverClaim.ClaimChanged, { op: "recover_claim", outcome: "claim_changed" }],
        [
          RunStoreMetrics.recoverClaim.LivenessUnconfirmed,
          { op: "recover_claim", outcome: "liveness_unconfirmed" }
        ],
        [RunStoreMetrics.abandonClaim.Abandoned, { op: "abandon_claim", outcome: "abandoned" }],
        [RunStoreMetrics.abandonClaim.ClaimLost, { op: "abandon_claim", outcome: "claim_lost" }],
        [RunStoreMetrics.steal.Claimed, { op: "steal", outcome: "claimed" }],
        [RunStoreMetrics.steal.NotFound, { op: "steal", outcome: "not_found" }],
        [RunStoreMetrics.steal.AlreadyClaimed, { op: "steal", outcome: "already_claimed" }],
        [RunStoreMetrics.steal.HeartbeatFresh, { op: "steal", outcome: "heartbeat_fresh" }],
        [RunStoreMetrics.steal.SnapshotChanged, { op: "steal", outcome: "snapshot_changed" }],
        [RunStoreMetrics.steal.LivenessUnconfirmed, { op: "steal", outcome: "liveness_unconfirmed" }]
      ] as const
      const heartbeat = [
        [RunStoreMetrics.heartbeat.Updated, { outcome: "updated" }],
        [RunStoreMetrics.heartbeat.FenceLost, { outcome: "fence_lost" }],
        [RunStoreMetrics.heartbeat.NotFound, { outcome: "not_found" }]
      ] as const
      const statuses = ["pending", "running", "suspended", "completed", "failed", "cancelled"] as const
      const transitions = statuses.flatMap((to) =>
        [
          [Metric.withAttributes(RunStoreMetrics.transition.Transitioned, { to }), { outcome: "transitioned", to }],
          [Metric.withAttributes(RunStoreMetrics.transition.FenceLost, { to }), { outcome: "fence_lost", to }],
          [Metric.withAttributes(RunStoreMetrics.transition.NotFound, { to }), { outcome: "not_found", to }],
          [Metric.withAttributes(RunStoreMetrics.transition.GuardFailed, { to }), { outcome: "guard_failed", to }]
        ] as const
      )
      const matrix = [...claims, ...heartbeat, ...transitions]
      const registry = new Map()
      yield* (
        Effect.forEach(matrix, ([metric]) => Metric.update(metric, 1), { discard: true }).pipe(
          Effect.provideService(Metric.MetricRegistry, registry)
        )
      )

      const normalized = (value: { readonly id: string; readonly attributes: Readonly<Record<string, string>> }) =>
        `${value.id}:${JSON.stringify(Object.entries(value.attributes).sort())}`
      const actual = Array.from(registry.values(), (metadata) => ({
        id: metadata.id,
        attributes: metadata.attributes
      })).sort((left, right) => normalized(left).localeCompare(normalized(right)))
      const expected = matrix.map(([metric, attributes]) => ({
        id: metric.id,
        attributes
      })).sort((left, right) => normalized(left).localeCompare(normalized(right)))

      expect(matrix).toHaveLength(54)
      expect(actual).toEqual(expected)
    }))

  it.effect("counts claim, activation, heartbeat, and transition outcomes through the provided registry", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-metrics", "{}")
        const pending = snapshot(yield* store.get("run-metrics"))
        const claimedAtMs = yield* Clock.currentTimeMillis

        expect(yield* store.claim("run-metrics", pending, ownerA, claimedAtMs)).toEqual({
          _tag: "Claimed",
          claimedAtMs
        })
        expect(yield* store.claim("run-metrics", pending, ownerB, claimedAtMs)).toEqual({ _tag: "AlreadyClaimed" })
        expect(yield* store.activate("run-metrics", ownerA, claimedAtMs, pending)).toEqual({ _tag: "Activated" })
        expect(yield* store.heartbeat("run-metrics", ownerA, claimedAtMs + 1)).toEqual({ _tag: "Updated" })
        expect(yield* store.heartbeat("run-metrics", ownerB, claimedAtMs + 2)).toEqual({ _tag: "FenceLost" })
        expect(yield* store.transitionOwned("run-metrics", ownerA, "completed")).toEqual({ _tag: "Transitioned" })
        // The terminal transition released ownership, so a repeat is fenced out.
        expect(yield* store.transitionOwned("run-metrics", ownerA, "completed")).toEqual({ _tag: "FenceLost" })

        expect(yield* count(RunStoreMetrics.claim.Claimed)).toBe(1)
        expect(yield* count(RunStoreMetrics.claim.AlreadyClaimed)).toBe(1)
        expect(yield* count(RunStoreMetrics.activate.Activated)).toBe(1)
        expect(yield* count(RunStoreMetrics.heartbeat.Updated)).toBe(1)
        expect(yield* count(RunStoreMetrics.heartbeat.FenceLost)).toBe(1)
        expect(
          yield* count(Metric.withAttributes(RunStoreMetrics.transition.Transitioned, { to: "completed" }))
        ).toBe(1)
        expect(
          yield* count(Metric.withAttributes(RunStoreMetrics.transition.FenceLost, { to: "completed" }))
        ).toBe(1)
        expect(yield* count(ObservabilityMetric.runThroughput)).toBe(1)
      }))
    }))

  it.effect("counts failed claim, heartbeat, and transition calls under outcome failure", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-metrics-failed", "{}")
        const pending = snapshot(yield* store.get("run-metrics-failed"))

        // A negative lease reading is refused before the write, so each call fails.
        expect(Exit.isFailure(yield* Effect.exit(store.claim("run-metrics-failed", pending, ownerA, -1)))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(store.heartbeat("run-metrics-failed", ownerA, -1)))).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(store.transitionOwned("", ownerA, "completed")))).toBe(true)

        expect(yield* count(Metric.withAttributes(RunStoreMetrics.claims, { op: "claim", outcome: "failure" })))
          .toBe(1)
        expect(yield* count(Metric.withAttributes(RunStoreMetrics.heartbeats, { outcome: "failure" }))).toBe(1)
        expect(
          yield* count(Metric.withAttributes(RunStoreMetrics.transitions, { outcome: "failure", to: "completed" }))
        ).toBe(1)
      }))
    }))

  it.effect("counts claimAndOwn activations and refused steals through the provided registry", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-metrics-own", "{}")
        const pending = snapshot(yield* store.get("run-metrics-own"))
        const nowMs = yield* Clock.currentTimeMillis

        expect(yield* store.claimAndOwn("run-metrics-own", pending, ownerA, nowMs)).toEqual({ _tag: "Activated" })
        // Evidence naming a different owner than the snapshot's is refused
        // before any compare-and-swap runs, and still counts as an outcome.
        const mismatched: LivenessEvidence = {
          expectedOwner: ownerB,
          checkedAtMs: nowMs,
          kind: "same-host-pid-dead"
        }
        expect(yield* store.steal("run-metrics-own", pending, ownerB, nowMs, mismatched)).toEqual({
          _tag: "LivenessUnconfirmed"
        })

        expect(yield* count(RunStoreMetrics.claimAndOwn.Activated)).toBe(1)
        expect(yield* count(RunStoreMetrics.steal.LivenessUnconfirmed)).toBe(1)
      }))
    }))

  it.effect("counts claim recovery and abandonment outcomes through the provided registry", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("run-metrics-claim-recovery", "{}")
        const pending = snapshot(yield* store.get("run-metrics-claim-recovery"))

        yield* store.claim("run-metrics-claim-recovery", pending, ownerA, 0)
        expect(yield* store.abandonClaim("run-metrics-claim-recovery", ownerA, 0)).toEqual({
          _tag: "Abandoned"
        })
        yield* store.claim("run-metrics-claim-recovery", pending, ownerA, 0)
        yield* TestClock.adjust("31000 millis")
        expect(
          yield* store.recoverClaim("run-metrics-claim-recovery", ownerA, 0, ownerB, 31_000, {
            expectedOwner: ownerA,
            checkedAtMs: 31_000,
            kind: "same-host-pid-dead"
          })
        ).toEqual({ _tag: "Recovered" })

        expect(yield* count(RunStoreMetrics.abandonClaim.Abandoned)).toBe(1)
        expect(yield* count(RunStoreMetrics.recoverClaim.Recovered)).toBe(1)
      }))
    }))
})
