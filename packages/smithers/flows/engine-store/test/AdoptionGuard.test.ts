/**
 * Round-6 adoption guard for stale running attempt rows.
 *
 * Issue #86: adoption keyed on `state === "running"` alone treated a live
 * concurrent same-key dispatch's freshly inserted row as crash evidence and
 * double-executed the sealed side effect. Issues #102/#103: the recorded
 * incarnation nonce was the wrong liveness evidence — it was compared
 * against a pre-claim read (a TOCTOU window where two dispatches both adopt)
 * and it refused same-incarnation re-drives whose fiber was provably dead
 * (reopening #71). Adoption now runs under the store incarnation's admission
 * permit: a running row observed while holding the key's permit cannot
 * belong to a live in-process fiber, so it is crash evidence regardless of
 * which incarnation recorded it.
 *
 * Issue #87: a compensable attempt's pre-image snapshot only reached the
 * durable row at finish, so adoption re-executed a crashed attempt 1 on the
 * dead incarnation's half-mutated workspace and snapshotted the dirty tree
 * as the compensation baseline. The pre-image is now patched into the
 * running row before the body runs, and adoption restores it.
 *
 * Issue #91: adoption re-emitted `attemptStarted`/`snapshotIdentified` as
 * fresh journal rows because lifecycle records carried no `sourceSeq`. They
 * now take a dedicated per-attempt producer identity, so a re-emission is an
 * exact retry the journal collapses into a `Duplicate`.
 */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "adoption-host", pid: 7, nonce: "live" }
const deadOwner: Ownership.OwnerId = { hostId: "adoption-host", pid: 7, nonce: "dead" }

const scriptedJj = (calls: Array<{ readonly op: string; readonly id?: string }>) =>
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: () =>
        Effect.sync(() => {
          calls.push({ op: "snapshot" })
          // A distinct change id: adoption and retry must restore the commit id.
          return { commitId: `fresh-${calls.length}` as never, changeId: `moving-${calls.length}` as never }
        }),
      restore: (id) =>
        Effect.sync(() => {
          calls.push({ op: "restore", id })
        }),
      diff: () => Effect.succeed(""),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed("")
    })
  )

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const now = yield* Clock.currentTimeMillis
    const claim = yield* runs.claim(runId, snapshot, owner, now)
    if (claim._tag !== "Claimed") {
      return yield* Effect.die(new Error(`run ${runId} claim was lost`))
    }
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") {
      return yield* Effect.die(new Error(`run ${runId} activation was lost`))
    }
  })

const layers = (calls: Array<{ readonly op: string; readonly id?: string }>) =>
  Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), scriptedJj(calls))

describe("adoption liveness evidence is the admission permit (issues #86, #102, #103)", () => {
  it.effect("adopts a running row left by a dead fiber of the current incarnation (issue #103)", () =>
    Effect.gen(function*() {
      // An in-process re-drive after a heartbeat-error self-interrupt: the
      // interrupted attempt fiber left its running row behind, and the store's
      // incarnation nonce is unchanged. The recorded-nonce guard read that as
      // a live concurrent dispatch and refused adoption, so the fall-through
      // `attempts.put` conflicted on the surviving row and permanently failed
      // the run with `AttemptAdmissionRejected` — reopening issue #71. With
      // the key permit held, no live in-process fiber can own the row, so it
      // is crash evidence and must re-execute.
      let dispatches = 0
      const key = "adoption/same-incarnation-redrive"
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("adoption-redrive")
          const attempts = yield* AttemptStore.AttemptStore
          const startedAtMs = yield* Clock.currentTimeMillis
          yield* attempts.put(
            {
              runId: "adoption-redrive",
              stepKeyDigest: sha256(key),
              attempt: 1,
              state: "running",
              startedAtMs,
              meta: { tier: "sealed", admittedBy: owner }
            },
            owner
          )
          return yield* ActionPersistence.make({
            runId: "adoption-redrive",
            owner,
            sourceId: "adoption-test",
            execute: () =>
              Effect.sync(() => {
                dispatches++
                return "recovered"
              })
          })({ action: {}, attempt: 1, key, tier: "sealed" })
        }).pipe(Effect.provide(layers([])), Effect.scoped)
      )
      expect(dispatches).toBe(1)
      expect(result).toBe("recovered")
    }))

  it.effect("serializes concurrent same-key dispatches so an irreversible body runs exactly once (issue #102)", () =>
    Effect.gen(function*() {
      // The pre-permit guard decided adoption from a read taken before the
      // claim landed: two concurrent dispatches could both observe the dead
      // owner's row before either re-homed it, both adopt, and both execute
      // the irreversible body. Under the shared admission permit the loser
      // waits out the winner's whole span and replays its terminal row.
      let dispatches = 0
      const key = "adoption/concurrent-claim"
      const results = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("adoption-concurrent")
          const attempts = yield* AttemptStore.AttemptStore
          // The dead incarnation's row: adoptable evidence for whichever
          // dispatch reads it first.
          yield* attempts.put(
            {
              runId: "adoption-concurrent",
              stepKeyDigest: sha256(key),
              attempt: 1,
              state: "running",
              startedAtMs: 0,
              meta: { tier: "irreversible", admittedBy: deadOwner }
            },
            owner
          )
          // One executor (one shared admission mutex), dispatched twice
          // concurrently — the in-process double-dispatch scenario.
          const dispatch = ActionPersistence.make({
            runId: "adoption-concurrent",
            owner,
            sourceId: "adoption-test",
            idempotencyKey: key,
            execute: () =>
              Effect.gen(function*() {
                dispatches++
                // Keep the body in flight long enough that the sibling
                // dispatch is admitted while this one is mid-execution.
                for (let i = 0; i < 20; i++) yield* Effect.yieldNow
                return "charged"
              })
          })
          const input = { action: {}, attempt: 1, key, tier: "irreversible" as const }
          return yield* Effect.all([dispatch(input), dispatch(input)], { concurrency: 2 })
        }).pipe(Effect.provide(layers([])), Effect.scoped)
      )
      expect(dispatches).toBe(1)
      expect(results).toEqual(["charged", "charged"])
    }))

  it.effect("still adopts a running row admitted by a superseded incarnation", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const key = "adoption/dead-owner"
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("adoption-dead")
          const attempts = yield* AttemptStore.AttemptStore
          yield* attempts.put(
            {
              runId: "adoption-dead",
              stepKeyDigest: sha256(key),
              attempt: 1,
              state: "running",
              startedAtMs: 0,
              meta: { tier: "sealed", admittedBy: deadOwner }
            },
            owner
          )
          const outcome = yield* ActionPersistence.make({
            runId: "adoption-dead",
            owner,
            sourceId: "adoption-test",
            execute: () =>
              Effect.sync(() => {
                dispatches++
                return "recovered"
              })
          })({ action: {}, attempt: 1, key, tier: "sealed" })
          return outcome
        }).pipe(Effect.provide(layers([])), Effect.scoped)
      )
      expect(dispatches).toBe(1)
      expect(result).toBe("recovered")
    }))
})

describe("adopted compensable attempts restore their own pre-image (issue #87)", () => {
  it.effect("restores the crashed attempt's persisted pre-image instead of snapshotting the dirty tree", () =>
    Effect.gen(function*() {
      const calls: Array<{ readonly op: string; readonly id?: string }> = []
      const key = "adoption/compensable"
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("adoption-compensable")
          const attempts = yield* AttemptStore.AttemptStore
          // The dead incarnation snapshotted the clean tree, persisted the
          // pre-image, half-mutated the workspace, and was SIGKILLed.
          yield* attempts.put(
            {
              runId: "adoption-compensable",
              stepKeyDigest: sha256(key),
              attempt: 1,
              state: "running",
              startedAtMs: 0,
              meta: { tier: "compensable", snapshotId: "pre-image", admittedBy: deadOwner }
            },
            owner
          )
          const outcome = yield* ActionPersistence.make({
            runId: "adoption-compensable",
            owner,
            sourceId: "adoption-test",
            execute: () => Effect.succeed("compensated")
          })({ action: {}, attempt: 1, key, tier: "compensable" })
          const row = yield* attempts.get({
            runId: "adoption-compensable",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          return { outcome, row }
        }).pipe(Effect.provide(layers(calls)), Effect.scoped)
      )
      // The clean tree is restored before re-execution and no fresh snapshot
      // of the dirty state becomes the compensation baseline.
      expect(calls).toEqual([{ op: "restore", id: "pre-image" }])
      expect(result.outcome).toBe("compensated")
      expect(Option.isSome(result.row)).toBe(true)
      if (Option.isSome(result.row)) {
        expect((result.row.value.meta as { snapshotId?: string }).snapshotId).toBe("pre-image")
      }
    }))

  it.effect("settles a completed compensable crossing from the row instead of restoring and re-running", () =>
    Effect.gen(function*() {
      // The pre-image exists to undo a PARTIAL mutation. A crossing that
      // recorded `succeeded` completed, so the workspace already holds the
      // whole mutation and the recorded outcome is its result: restoring the
      // pre-image here would throw finished work away and run the body again.
      const calls: Array<{ readonly op: string; readonly id?: string }> = []
      let dispatches = 0
      const key = "adoption/compensable-crossed"
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("adoption-crossed")
          const attempts = yield* AttemptStore.AttemptStore
          yield* attempts.put(
            {
              runId: "adoption-crossed",
              stepKeyDigest: sha256(key),
              attempt: 1,
              state: "running",
              startedAtMs: 0,
              outcome: "rebased",
              meta: {
                tier: "compensable",
                snapshotId: "pre-image",
                admittedBy: deadOwner,
                effectCrossing: "succeeded"
              }
            },
            owner
          )
          const outcome = yield* ActionPersistence.make({
            runId: "adoption-crossed",
            owner,
            sourceId: "adoption-test",
            execute: () =>
              Effect.sync(() => {
                dispatches++
                return "must-not-run"
              })
          })({ action: {}, attempt: 1, key, tier: "compensable" })
          const row = yield* attempts.get({
            runId: "adoption-crossed",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          return { outcome, row }
        }).pipe(Effect.provide(layers(calls)), Effect.scoped)
      )
      expect(dispatches).toBe(0)
      expect(result.outcome).toBe("rebased")
      expect(calls).toEqual([])
      const row = Option.getOrThrow(result.row)
      expect(row.state).toBe("succeeded")
      // The tier-2 anchor the dead incarnation recorded survives the
      // settlement, so a later rewind still has a pointer to restore against.
      expect((row.meta as { readonly snapshotId?: string }).snapshotId).toBe("pre-image")
    }))

  it.effect("persists the pre-image into the running row before executing the body", () =>
    Effect.gen(function*() {
      const calls: Array<{ readonly op: string; readonly id?: string }> = []
      const key = "adoption/pre-image-persisted"
      const observed = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("adoption-preimage")
          const attempts = yield* AttemptStore.AttemptStore
          let runningMeta: unknown
          yield* ActionPersistence.make({
            runId: "adoption-preimage",
            owner,
            sourceId: "adoption-test",
            execute: () =>
              Effect.gen(function*() {
                const row = yield* attempts.get({
                  runId: "adoption-preimage",
                  stepKeyDigest: sha256(key),
                  attempt: 1
                })
                runningMeta = Option.isSome(row) ? row.value.meta : undefined
                return "done"
              })
          })({ action: {}, attempt: 1, key, tier: "compensable" })
          return runningMeta
        }).pipe(Effect.provide(layers(calls)), Effect.scoped)
      )
      // A SIGKILL at any point during the body must find the pre-image in the
      // durable row, not only at finish.
      expect((observed as { snapshotId?: string }).snapshotId).toBe("fresh-1")
    }))
})

describe("adoption re-emissions are producer-idempotent (issue #91)", () => {
  it.effect("collapses the re-executed attempt's announcements into the dead incarnation's rows", () =>
    Effect.gen(function*() {
      const calls: Array<{ readonly op: string; readonly id?: string }> = []
      const key = "adoption/dedupe"
      const digest = sha256(key)
      const events = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("adoption-dedupe")
          const attempts = yield* AttemptStore.AttemptStore
          const journal = yield* Journal.Journal
          // The dead incarnation admitted the attempt, announced it, snapshotted
          // and announced the pre-image, then was SIGKILLed mid-body.
          yield* attempts.put(
            {
              runId: "adoption-dedupe",
              stepKeyDigest: digest,
              attempt: 1,
              state: "running",
              startedAtMs: 0,
              meta: { tier: "compensable", snapshotId: "pre-image", admittedBy: deadOwner }
            },
            owner
          )
          const attemptId = { runId: "adoption-dedupe", stepKeyDigest: digest, attempt: 1 }
          yield* journal.emitDurable(
            JournalRecords.attemptStarted(
              {
                runId: "adoption-dedupe",
                lineageId: FlowEngine.Lineage.root("adoption-dedupe"),
                sourceId: `adoption-test:attempt:${digest}:1:started`,
                sourceSeq: 0
              },
              { ...attemptId, tier: "compensable" }
            ),
            owner
          )
          yield* journal.emitDurable(
            JournalRecords.snapshotIdentified(
              {
                runId: "adoption-dedupe",
                lineageId: FlowEngine.Lineage.root("adoption-dedupe"),
                sourceId: `adoption-test:attempt:${digest}:1:snapshot`,
                sourceSeq: 0
              },
              { ...attemptId, snapshotId: "pre-image" }
            ),
            owner
          )
          yield* ActionPersistence.make({
            runId: "adoption-dedupe",
            owner,
            sourceId: "adoption-test",
            execute: () => Effect.succeed("recovered")
          })({ action: {}, attempt: 1, key, tier: "compensable" })
          const page = yield* journal.entries({ runId: "adoption-dedupe" as never, limit: 100 })
          return page.entries
        }).pipe(Effect.provide(layers(calls)), Effect.scoped)
      )
      const started = events.filter((event) => event.eventType === "flows.engine.attempt-started")
      const snapshots = events.filter((event) => event.eventType === "flows.engine.snapshot-identified")
      expect(started).toHaveLength(1)
      expect(snapshots).toHaveLength(1)
    }))
})

describe("the adoption claim is fenced at the moment it lands (issue #102)", () => {
  const seedAdoptable = (runId: string, key: string) =>
    Effect.gen(function*() {
      yield* activate(runId)
      const attempts = yield* AttemptStore.AttemptStore
      yield* attempts.put(
        {
          runId,
          stepKeyDigest: sha256(key),
          attempt: 1,
          state: "running",
          startedAtMs: 0,
          meta: { tier: "sealed", admittedBy: deadOwner }
        },
        owner
      )
    })

  it.effect("parks instead of re-homing when the run fence was lost while waiting", () =>
    Effect.gen(function*() {
      // The entry heartbeat passes; the claim-time re-verification fails —
      // exactly a fence lost between admission and the claim landing.
      let dispatches = 0
      let heartbeats = 0
      const flakyFence = Layer.effect(RunStore.RunStore)(
        Effect.gen(function*() {
          const real = yield* RunStore.RunStore
          return {
            ...real,
            heartbeat: (runId: string, who: Ownership.OwnerId, nowMs: number) =>
              Effect.suspend(() => {
                heartbeats++
                return heartbeats === 1
                  ? real.heartbeat(runId, who, nowMs)
                  : Effect.succeed({ _tag: "FenceLost" } as const)
              })
          }
        })
      )
      const key = "adoption/claim-fence-lost"
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* seedAdoptable("adoption-fence", key)
          return yield* Effect.exit(
            ActionPersistence.make({
              runId: "adoption-fence",
              owner,
              sourceId: "adoption-test",
              execute: () =>
                Effect.sync(() => {
                  dispatches++
                  return "must-not-run"
                })
            })({ action: {}, attempt: 1, key, tier: "sealed" })
          )
        }).pipe(
          Effect.provide(flakyFence.pipe(Layer.provideMerge(layers([])))),
          Effect.scoped
        )
      )
      expect(dispatches).toBe(0)
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("Interrupt")
    }))

  it.effect("parks when the adoptable row vanished before the re-home landed", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const vanishingPatch = Layer.effect(AttemptStore.AttemptStore)(
        Effect.gen(function*() {
          const real = yield* AttemptStore.AttemptStore
          return {
            ...real,
            patch: () => Effect.succeed({ _tag: "NotFound" } as const)
          }
        })
      )
      const key = "adoption/claim-row-vanished"
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* seedAdoptable("adoption-vanish", key)
          return yield* Effect.exit(
            ActionPersistence.make({
              runId: "adoption-vanish",
              owner,
              sourceId: "adoption-test",
              execute: () =>
                Effect.sync(() => {
                  dispatches++
                  return "must-not-run"
                })
            })({ action: {}, attempt: 1, key, tier: "sealed" })
          )
        }).pipe(
          Effect.provide(vanishingPatch.pipe(Layer.provideMerge(layers([])))),
          Effect.scoped
        )
      )
      expect(dispatches).toBe(0)
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("Interrupt")
    }))
})
