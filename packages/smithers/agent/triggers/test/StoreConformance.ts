import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import { reservationLeaseMs } from "../src/TriggerStore.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const declaration = {
  id: "daily",
  flowId: "flow",
  input: { nested: [1, "two", null], enabled: true },
  cron: "0 0 * * *",
  overlap: "skip" as const,
  catchUp: "none" as const,
  maxCatchUp: 1,
  enabled: true
}

/** Declares the contract shared by durable and in-memory trigger stores. */
export const storeConformance = <LayerError>(
  name: string,
  layer: Layer.Layer<TriggerStore.TriggerStore, LayerError>
): void => {
  const run = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer())
      )
    )

  describe(`${name} TriggerStore conformance`, () => {
    it("reports unknown_trigger from every missing-row path", async () => {
      const errors = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          return yield* Effect.all([
            Effect.flip(store.claimFire({ triggerId: "absent", occurrence: 1, expectedRevision: 1 })),
            Effect.flip(store.recordResult({ triggerId: "absent", occurrence: 1, outcome: "completed" })),
            Effect.flip(store.setPending({ triggerId: "absent", occurrence: 1 })),
            Effect.flip(store.restorePending({ triggerId: "absent", occurrence: 1, reservationId: "absent" })),
            Effect.flip(store.activeRun("absent")),
            Effect.flip(store.activeOccurrence("absent", "run-1")),
            Effect.flip(store.claimPending({ triggerId: "absent", expectedRevision: 1 })),
            Effect.flip(store.inspect("absent"))
          ])
        })
      )
      for (const error of errors) {
        expect(error.code).toBe("unknown_trigger")
        expect(error.message).toBe("unknown trigger absent")
      }
    })

    it("lists what each row holds beside its decoded declaration", async () => {
      const listing = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
          const fire = { triggerId: declaration.id, expectedRevision: registered.revision }
          yield* store.claimFire({ ...fire, occurrence: 1 })
          yield* store.recordResult({
            ...fire,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.setPending({ triggerId: declaration.id, occurrence: 2 })
          return yield* store.list()
        })
      )
      // The scheduler decides from this snapshot whether to ask the store
      // again, so a listing that dropped the held columns cost a write
      // transaction per trigger per tick to read them back one row at a time.
      expect(listing).toHaveLength(1)
      expect(listing[0]).toMatchObject({ triggerId: declaration.id, activeRunId: "run-1", pendingAt: 2 })
      expect(Result.getOrThrow(listing[0]!.trigger)).toMatchObject({ id: declaration.id, revision: 1 })
    })

    it("prunes settled fires older than a cutoff and keeps what the scheduler still reads", async () => {
      const state = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
          const fire = { triggerId: declaration.id, expectedRevision: registered.revision }
          // Occurrence 1 settles, occurrence 2 launches and stays active, and
          // occurrence 3 is buffered behind it.
          yield* store.claimFire({ ...fire, occurrence: 1 })
          yield* store.recordResult({
            ...fire,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.recordResult({ ...fire, occurrence: 1, outcome: "completed", runId: "run-1" })
          yield* store.claimFire({ ...fire, occurrence: 2 })
          yield* store.recordResult({
            ...fire,
            occurrence: 2,
            outcome: "launched",
            runId: "run-2",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.claimFire({ ...fire, occurrence: 3 })
          const removed = yield* store.pruneFires({ olderThan: 4 })
          return {
            removed,
            items: (yield* store.history()).items,
            held: yield* store.inspect(declaration.id),
            refused: yield* Effect.flip(store.pruneFires({ olderThan: 1.5 }))
          }
        })
      )
      expect(state.removed).toBe(1)
      expect(state.items.map((item) => item.occurrence)).toEqual([3, 2])
      expect(state.held).toMatchObject({ activeRunId: "run-2", pendingAt: 3 })
      expect(state.refused).toMatchObject({ code: "invalid_options", path: "olderThan" })
    })

    it("uses exact revision and enabled claim fences", async () => {
      const refusals = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          const stale = yield* Effect.flip(
            store.claimFire({
              triggerId: declaration.id,
              occurrence: 1,
              expectedRevision: registered.revision + 1
            })
          )
          const disabled = yield* store.register({ ...declaration, enabled: false })
          const off = yield* Effect.flip(
            store.claimFire({
              triggerId: declaration.id,
              occurrence: 1,
              expectedRevision: disabled.revision
            })
          )
          return { stale, off }
        })
      )
      expect(refusals.stale.code).toBe("revision_mismatch")
      expect(refusals.stale.message).toBe("trigger daily is at revision 1, not the claimed 2")
      expect(refusals.off.code).toBe("trigger_disabled")
      expect(refusals.off.message).toBe("trigger daily is disabled")
    })

    it("round-trips registered JSON input exactly", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          return { registered, stored: yield* store.get(declaration.id) }
        })
      )
      expect(result.registered.input).toEqual(declaration.input)
      expect(result.stored).toMatchObject({ _tag: "Some", value: { input: declaration.input } })
    })

    it("snapshots registration input before the returned Effect runs", async () => {
      const stored = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const input = { value: 1 }
          const registration = store.register({ ...declaration, input })
          input.value = 2
          yield* registration
          return yield* store.get(declaration.id)
        })
      )
      expect(stored).toMatchObject({ _tag: "Some", value: { input: { value: 1 } } })
    })

    it("hands back readings that cannot be mutated into stored state", async () => {
      const stored = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, id: "aliased", input: { nested: [1] } })
          ;(registered.input as { nested: Array<unknown> }).nested.push("through the registration")
          const listed = yield* store.list()
          ;(Result.getOrThrow(listed[0]!.trigger).input as { nested: Array<unknown> }).nested.push(
            "through the listing"
          )
          return yield* store.get("aliased")
        })
      )
      expect(stored).toMatchObject({ _tag: "Some", value: { input: { nested: [1] } } })
    })

    it("refuses a declaration the schedule cannot satisfy", async () => {
      const error = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          return yield* Effect.flip(store.register({ ...declaration, id: "february", cron: "0 0 30 2 *" }))
        })
      )
      expect(error.code).toBe("unsatisfiable_cron")
    })

    it("lists triggers ordered by id", async () => {
      const listed = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          yield* store.register({ ...declaration, id: "weekly" })
          yield* store.register({ ...declaration, id: "hourly" })
          yield* store.register({ ...declaration, id: "daily", enabled: false })
          return { all: yield* store.list(), enabled: yield* store.listEnabled() }
        })
      )
      expect(listed.all.map((row) => row.triggerId)).toEqual(["daily", "hourly", "weekly"])
      expect(listed.enabled.map((registered) => registered.id)).toEqual(["hourly", "weekly"])
    })

    it("holds live reservations and reclaims them after the shared lease", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          const first = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs - 1)
          const live = yield* store.activeRun(declaration.id)
          yield* TestClock.adjust(2)
          const expired = yield* store.activeRun(declaration.id)
          const retried = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          return { first, live, expired, retried }
        })
      )
      expect(result.first).toMatchObject({ claimed: true, action: "fire" })
      expect(result.live).toMatchObject({
        _tag: "Some",
        value: expect.stringMatching(/^trigger-reservation:daily:[^:]+:1$/)
      })
      expect(result.expired).toMatchObject({ _tag: "None" })
      expect(result.retried).toMatchObject({ claimed: true, action: "fire" })
    })

    it("maps reservations and launched runs to their claimed occurrence", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          const claim = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 7,
            expectedRevision: registered.revision
          })
          if (!claim.claimed || (claim.action !== "fire" && claim.action !== "supersede")) {
            return yield* Effect.die("expected a launch reservation")
          }
          const reserved = yield* store.activeOccurrence(declaration.id, claim.reservationId)
          const otherReservation = yield* store.activeOccurrence(
            declaration.id,
            TriggerStore.reservationId(declaration.id, 8)
          )
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 7,
            outcome: "launched",
            runId: "run-7",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          const launched = yield* store.activeOccurrence(declaration.id, "run-7")
          const unknown = yield* store.activeOccurrence(declaration.id, "run-missing")
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 7,
            outcome: "completed",
            runId: "run-7"
          })
          const settled = yield* store.activeOccurrence(declaration.id, "run-7")
          return { reserved, otherReservation, launched, unknown, settled }
        })
      )
      expect(result.reserved).toMatchObject({ _tag: "Some", value: 7 })
      expect(result.otherReservation).toMatchObject({ _tag: "Some", value: 8 })
      expect(result.launched).toMatchObject({ _tag: "Some", value: 7 })
      expect(result.unknown).toMatchObject({ _tag: "None" })
      expect(result.settled).toMatchObject({ _tag: "None" })
    })

    it("advances the fire cursor only after a launch is durable", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 7,
            expectedRevision: registered.revision
          })
          const claimed = yield* store.get(declaration.id)
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 7,
            outcome: "launched",
            runId: "run-7",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          return { claimed, launched: yield* store.get(declaration.id) }
        })
      )
      expect(result.claimed._tag).toBe("Some")
      expect(result.claimed._tag === "Some" ? result.claimed.value.lastFiredAt : null).toBeUndefined()
      expect(result.launched).toMatchObject({ _tag: "Some", value: { lastFiredAt: 7 } })
    })

    it("does not let an old unqualified result clear a newer active run", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "completed",
            runId: "run-1"
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 2,
            outcome: "launched",
            runId: "run-2",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.recordResult({ triggerId: declaration.id, occurrence: 1, outcome: "completed" })
          const afterOld = yield* store.activeRun(declaration.id)
          yield* store.recordResult({ triggerId: declaration.id, occurrence: 2, outcome: "completed" })
          return { afterOld, afterCurrent: yield* store.activeRun(declaration.id) }
        })
      )
      expect(result.afterOld).toMatchObject({ _tag: "Some", value: "run-2" })
      expect(result.afterCurrent).toMatchObject({ _tag: "None" })
    })

    it("reclaims an expired reservation inside a later claim without losing its occurrence", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const claim = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          return { claim, pending: (yield* store.inspect(declaration.id)).pendingAt }
        })
      )
      expect(result.claim).toMatchObject({
        claimed: true,
        action: "fire",
        reservationId: expect.stringMatching(/^trigger-reservation:daily:[^:]+:2$/)
      })
      expect(result.pending).toBe(1)
    })

    it("restores the predecessor behind an expired supersede reservation", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "supersede" })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          const first = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          const second = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 3,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const active = yield* store.activeRun(declaration.id)
          return {
            first,
            second,
            active,
            pending: (yield* store.inspect(declaration.id)).pendingAt,
            occurrence: yield* store.activeOccurrence(declaration.id, "run-1")
          }
        })
      )
      expect(result.first).toMatchObject({ claimed: true, action: "supersede", activeRunId: "run-1" })
      expect(result.second).toMatchObject({ claimed: true, action: "supersede", activeRunId: "run-1" })
      expect(result.active).toMatchObject({ _tag: "Some", value: "run-1" })
      expect(result.pending).toBe(3)
      expect(result.occurrence).toMatchObject({ _tag: "Some", value: 1 })
    })

    it("supersedes an uncommitted reservation without inventing a predecessor", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "supersede" })
          const first = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          const second = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          return { first, second }
        })
      )
      expect(result.first).toMatchObject({ claimed: true, action: "fire" })
      expect(result.second).toMatchObject({
        claimed: true,
        action: "supersede",
        activeRunId: expect.stringMatching(/^trigger-reservation:daily:[^:]+:1$/)
      })
    })

    it("recovers a supersede predecessor inside a later claim", async () => {
      const claim = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "supersede" })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          return yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 3,
            expectedRevision: registered.revision
          })
        })
      )
      expect(claim).toMatchObject({ claimed: true, action: "supersede", activeRunId: "run-1" })
    })

    it("reclaims an expired supersede reservation with no predecessor", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "supersede" })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const same = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const later = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          return { same, later }
        })
      )
      expect(result.same).toMatchObject({ claimed: true, action: "fire" })
      expect(result.later).toMatchObject({ claimed: true, action: "fire" })
    })

    it("refuses a pending supersede when its recorded predecessor no longer matches", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "supersede" })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          yield* store.restorePending({
            triggerId: declaration.id,
            occurrence: 2,
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.clearActive(declaration.id, "run-1")
          yield* store.claimFire({ triggerId: declaration.id, occurrence: 3, expectedRevision: registered.revision })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 3,
            outcome: "launched",
            runId: "run-2",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.setPending({ triggerId: declaration.id, occurrence: 2 })
          const claimed = yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          return { claimed, pending: (yield* store.inspect(declaration.id)).pendingAt }
        })
      )
      expect(result.claimed).toMatchObject({ _tag: "Some", value: { claim: { claimed: false } } })
      expect(result.pending).toBe(2)
    })

    it("holds and then reclaims the reservation for the same occurrence", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          const first = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          const live = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const expired = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          return { first, live, expired }
        })
      )
      expect(result.first).toMatchObject({ claimed: true, action: "fire" })
      expect(result.live).toMatchObject({ claimed: false })
      expect(result.expired).toMatchObject({ claimed: true, action: "fire" })
    })

    it("reclaims reservations with no claim timestamp", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const activeRegistered = yield* store.register({ ...declaration, id: "active-null" })
          const activeReservation = TriggerStore.reservationId("active-null", 1)
          yield* store.claimFire({
            triggerId: "active-null",
            occurrence: 1,
            expectedRevision: activeRegistered.revision
          })
          yield* store.recordResult({
            triggerId: "active-null",
            occurrence: 1,
            outcome: "launched",
            runId: activeReservation,
            reservationId: (yield* store.inspect("active-null")).activeRunId!
          })
          const active = yield* store.activeRun("active-null")

          const claimRegistered = yield* store.register({ ...declaration, id: "claim-null" })
          const claimReservation = TriggerStore.reservationId("claim-null", 1)
          yield* store.claimFire({
            triggerId: "claim-null",
            occurrence: 1,
            expectedRevision: claimRegistered.revision
          })
          yield* store.recordResult({
            triggerId: "claim-null",
            occurrence: 1,
            outcome: "launched",
            runId: claimReservation,
            reservationId: (yield* store.inspect("claim-null")).activeRunId!
          })
          const claim = yield* store.claimFire({
            triggerId: "claim-null",
            occurrence: 2,
            expectedRevision: claimRegistered.revision
          })
          return { active, claim }
        })
      )
      expect(result.active).toMatchObject({ _tag: "None" })
      expect(result.claim).toMatchObject({
        claimed: true,
        action: "fire",
        reservationId: expect.stringMatching(/^trigger-reservation:claim-null:[^:]+:2$/)
      })
    })

    it.each([undefined, "", "   "])("rejects an invalid launched run id %s without changing state", async (runId) => {
      await run(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(declaration)
        const claim = yield* store.claimFire({
          triggerId: declaration.id,
          occurrence: 1,
          expectedRevision: registered.revision
        })
        if (!claim.claimed || claim.action !== "fire") return yield* Effect.die("expected reservation")
        const before = yield* store.inspect(declaration.id)
        const result = yield* Effect.exit(store.recordResult({
          triggerId: declaration.id,
          occurrence: 1,
          outcome: "launched",
          runId,
          reservationId: claim.reservationId
        } as TriggerStore.Result))
        expect(result._tag).toBe("Failure")
        expect(yield* store.inspect(declaration.id)).toEqual(before)
        expect((yield* store.history()).items[0]?.outcome).toBe(null)
      }))
    })

    it.each(["newer claim", "terminal settlement"])("fences delayed launched results after %s", async (after) => {
      await run(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...declaration, overlap: "supersede" })
        const first = yield* store.claimFire({
          triggerId: declaration.id,
          occurrence: 1,
          expectedRevision: registered.revision
        })
        if (!first.claimed || first.action !== "fire") return yield* Effect.die("expected reservation")
        if (after === "newer claim") {
          const second = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          if (!second.claimed || (second.action !== "fire" && second.action !== "supersede")) {
            return yield* Effect.die("expected reservation")
          }
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 2,
            outcome: "launched",
            runId: "new-run",
            reservationId: second.reservationId
          })
        } else {
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "completed",
            reservationId: first.reservationId
          })
        }
        const before = yield* store.inspect(declaration.id)
        const ledger = yield* store.history()
        const late = yield* Effect.exit(
          store.recordResult(
            {
              triggerId: declaration.id,
              occurrence: 1,
              outcome: "launched",
              runId: "old-run",
              reservationId: first.reservationId
            } as TriggerStore.Result
          )
        )
        expect(yield* store.inspect(declaration.id)).toEqual(before)
        expect(yield* store.history()).toEqual(ledger)
        expect(late._tag).toBe("Failure")
      }))
    })

    it("refuses results for unclaimed occurrences without moving the cursor", async () => {
      await run(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(declaration)
        const before = yield* store.get(declaration.id)
        expect(
          (yield* Effect.flip(store.recordResult({ triggerId: declaration.id, occurrence: 1, outcome: "completed" })))
            .code
        ).toBe("stale_owner")
        expect(yield* store.history()).toEqual({ items: [] })
        expect(yield* store.get(declaration.id)).toEqual(before)
      }))
    })

    it.each([true, false])("restores only a still-launched predecessor (%s)", async (live) => {
      await run(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...declaration, overlap: "supersede" })
        const fire = { triggerId: declaration.id, occurrence: 1, expectedRevision: registered.revision }
        yield* store.claimFire(fire)
        yield* store.recordResult({
          ...fire,
          outcome: "launched",
          runId: "predecessor",
          reservationId: (yield* store.inspect(declaration.id)).activeRunId!
        })
        const replacement = yield* store.claimFire({ ...fire, occurrence: 2 })
        if (!replacement.claimed || replacement.action !== "supersede") return yield* Effect.die("expected supersede")
        if (!live) yield* store.recordResult({ ...fire, outcome: "superseded", runId: "predecessor" })
        yield* store.restorePending({ ...fire, occurrence: 2, reservationId: replacement.reservationId })
        expect(yield* store.inspect(declaration.id)).toEqual(
          live ? { activeRunId: "predecessor", pendingAt: 2 } : { pendingAt: 2 }
        )
      }))
    })

    it("fences a previous attempt after the same occurrence is reclaimed", async () => {
      await run(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(declaration)
        const fire = { triggerId: declaration.id, occurrence: 1, expectedRevision: registered.revision }
        const first = yield* store.claimFire(fire)
        yield* TestClock.adjust(reservationLeaseMs + 1)
        const second = yield* store.claimFire(fire)
        if (!first.claimed || first.action !== "fire" || !second.claimed || second.action !== "fire") {
          return yield* Effect.die("expected reservations")
        }
        expect(first.reservationId).not.toBe(second.reservationId)
        const before = yield* store.inspect(declaration.id)
        for (const outcome of ["launched", "failed", "superseded"] as const) {
          const stale = yield* Effect.flip(
            store.recordResult({ ...fire, outcome, runId: "old-run", reservationId: first.reservationId })
          )
          expect(stale.code).toBe("stale_owner")
          expect(yield* store.inspect(declaration.id)).toEqual(before)
          expect((yield* store.history()).items[0]?.outcome).toBe(null)
        }
        yield* store.recordResult({
          ...fire,
          outcome: "launched",
          runId: "new-run",
          reservationId: second.reservationId
        })
        expect(yield* store.inspect(declaration.id)).toEqual({ activeRunId: "new-run" })
      }))
    })

    it("atomically restores a buffered reservation and refuses stale compensation", async () => {
      await run(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
        const fire = { triggerId: declaration.id, occurrence: 1, expectedRevision: registered.revision }
        yield* store.claimFire(fire)
        yield* store.claimFire({ ...fire, occurrence: 2 })
        yield* store.recordResult({ ...fire, outcome: "completed" })
        const pending = yield* store.claimPending(fire)
        if (pending._tag !== "Some" || !pending.value.claim.claimed || pending.value.claim.action !== "fire") {
          return yield* Effect.die("expected buffered reservation")
        }
        const reservationId = pending.value.claim.reservationId
        const restore = { triggerId: declaration.id, occurrence: 2, reservationId }
        expect(yield* store.inspect(declaration.id)).toEqual({ activeRunId: reservationId })
        yield* store.restorePending(restore)
        expect(yield* store.inspect(declaration.id)).toEqual({ pendingAt: 2 })
        expect((yield* store.history()).items[0]?.outcome).toBe("buffered")
        const retry = yield* store.claimPending(fire)
        if (retry._tag !== "Some" || !retry.value.claim.claimed || retry.value.claim.action !== "fire") {
          return yield* Effect.die("expected retry")
        }
        yield* store.setPending({ ...fire, occurrence: 3 })
        const before = yield* store.inspect(declaration.id)
        expect((yield* Effect.flip(store.restorePending(restore))).code).toBe("stale_owner")
        expect(yield* store.inspect(declaration.id)).toEqual(before)
        yield* store.restorePending({ ...restore, reservationId: retry.value.claim.reservationId })
        expect(yield* store.inspect(declaration.id)).toEqual({ pendingAt: 3 })
      }))
    })

    it("refuses a terminal result naming a different run without rewriting the ledger", async () => {
      await run(Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(declaration)
        const fire = { triggerId: declaration.id, occurrence: 1, expectedRevision: registered.revision }
        const claim = yield* store.claimFire(fire)
        if (!claim.claimed || claim.action !== "fire") return yield* Effect.die("expected reservation")
        yield* store.recordResult({ ...fire, outcome: "launched", runId: "run", reservationId: claim.reservationId })
        const before = yield* store.history()
        expect((yield* Effect.flip(store.recordResult({ ...fire, outcome: "completed", runId: "other-run" }))).code)
          .toBe("stale_owner")
        expect(yield* store.history()).toEqual(before)
        expect(yield* store.inspect(declaration.id)).toEqual({ activeRunId: "run" })
        yield* store.recordResult({ ...fire, outcome: "completed" })
        const settled = yield* store.history()
        yield* store.recordResult({ ...fire, outcome: "completed", runId: "run" })
        expect((yield* Effect.flip(store.recordResult({ ...fire, outcome: "completed", runId: "other-run" }))).code)
          .toBe("stale_owner")
        expect(yield* store.history()).toEqual(settled)
        expect(yield* store.inspect(declaration.id)).toEqual({})
        expect(
          (yield* Effect.flip(
            store.recordResult({ ...fire, outcome: "launched", runId: "late-run", reservationId: claim.reservationId })
          )).code
        ).toBe("stale_owner")
      }))
    })

    it("claims and clears one buffered occurrence atomically", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
          const empty = yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          const buffered = yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "completed"
          })
          const resumed = yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          return { empty, buffered, resumed, pending: (yield* store.inspect(declaration.id)).pendingAt }
        })
      )
      expect(result.empty).toMatchObject({ _tag: "None" })
      expect(result.buffered).toMatchObject({ claimed: true, action: "buffer" })
      expect(result.resumed).toMatchObject({
        _tag: "Some",
        value: { occurrence: 2, claim: { claimed: true, action: "fire" } }
      })
      expect(result.pending).toBeUndefined()
    })

    it("keeps a pending occurrence when a concurrent run buffers it again", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "completed",
            runId: "run-1"
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 3,
            expectedRevision: registered.revision
          })
          const claimed = yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          return { claimed, pending: (yield* store.inspect(declaration.id)).pendingAt }
        })
      )
      expect(result.claimed).toMatchObject({
        _tag: "Some",
        value: { occurrence: 2, claim: { claimed: true, action: "buffer" } }
      })
      expect(result.pending).toBe(2)
    })

    it("keeps pending work when a claim is refused", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 3,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 3,
            outcome: "skipped"
          })
          yield* store.setPending({ triggerId: declaration.id, occurrence: 3 })
          const refused = yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          return { refused, pending: (yield* store.inspect(declaration.id)).pendingAt }
        })
      )
      expect(result.refused).toMatchObject({
        _tag: "Some",
        value: { occurrence: 3, claim: { claimed: false } }
      })
      expect(result.pending).toBe(3)
    })

    it("keeps pending work behind revision and disabled fences", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          yield* store.setPending({ triggerId: declaration.id, occurrence: 4 })
          const stale = yield* Effect.flip(
            store.claimPending({
              triggerId: declaration.id,
              expectedRevision: registered.revision + 1
            })
          )
          const afterStale = (yield* store.inspect(declaration.id)).pendingAt
          yield* store.setPending({ triggerId: declaration.id, occurrence: 5 })
          const disabled = yield* store.register({ ...declaration, enabled: false })
          const off = yield* Effect.flip(
            store.claimPending({
              triggerId: declaration.id,
              expectedRevision: disabled.revision
            })
          )
          return { stale, afterStale, off, afterOff: (yield* store.inspect(declaration.id)).pendingAt }
        })
      )
      expect(result.stale.code).toBe("revision_mismatch")
      expect(result.stale.message).toBe("trigger daily is at revision 1, not the claimed 2")
      expect(result.afterStale).toBe(4)
      expect(result.off.code).toBe("trigger_disabled")
      expect(result.off.message).toBe("trigger daily is disabled")
      expect(result.afterOff).toBe(5)
    })

    it("re-arms claimed buffered work when its reservation expires", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 1,
            expectedRevision: registered.revision
          })
          yield* store.claimFire({
            triggerId: declaration.id,
            occurrence: 2,
            expectedRevision: registered.revision
          })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "completed"
          })
          yield* store.claimPending({
            triggerId: declaration.id,
            expectedRevision: registered.revision
          })
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const active = yield* store.activeRun(declaration.id)
          return { active, pending: (yield* store.inspect(declaration.id)).pendingAt }
        })
      )
      expect(result.active).toMatchObject({ _tag: "None" })
      expect(result.pending).toBe(2)
    })

    it("reads the ledger newest first with each occurrence's outcome, run, and error", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register(declaration)
          const claim = { triggerId: declaration.id, expectedRevision: registered.revision }
          yield* store.claimFire({ ...claim, occurrence: 1 })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          // Skipped inside the claim: run-1 is still active under the skip policy.
          yield* store.claimFire({ ...claim, occurrence: 2 })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "failed",
            runId: "run-1",
            error: "exit 1"
          })
          // Claimed and not yet reported: the ledger shows the open window.
          yield* store.claimFire({ ...claim, occurrence: 3 })
          return {
            all: yield* store.history({ triggerId: declaration.id }),
            byRun: yield* store.history({ runId: "run-1" }),
            skipped: yield* store.history({ outcome: "skipped" }),
            other: yield* store.history({ triggerId: "other" }),
            everything: yield* store.history()
          }
        })
      )
      expect(result.all).toEqual({
        items: [
          { triggerId: "daily", occurrence: 3, outcome: null },
          { triggerId: "daily", occurrence: 2, outcome: "skipped" },
          { triggerId: "daily", occurrence: 1, outcome: "failed", runId: "run-1", error: "exit 1" }
        ]
      })
      expect(result.byRun.items).toEqual([result.all.items[2]])
      expect(result.skipped.items).toEqual([result.all.items[1]])
      expect(result.other.items).toEqual([])
      expect(result.everything).toEqual(result.all)
    })

    it("pages the ledger by cursor across triggers that share an occurrence", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          for (const id of ["a", "b"]) {
            const registered = yield* store.register({ ...declaration, id })
            yield* store.claimFire({ triggerId: id, occurrence: 5, expectedRevision: registered.revision })
            yield* store.claimFire({ triggerId: id, occurrence: 3, expectedRevision: registered.revision })
          }
          const first = yield* store.history({ limit: 3 })
          const second = yield* store.history({ limit: 3, cursor: first.nextCursor })
          const exact = yield* store.history({ limit: 4 })
          return { first, second, exact }
        })
      )
      const position = (record: TriggerStore.FireRecord) => `${record.triggerId}:${record.occurrence}`
      expect(result.first.items.map(position)).toEqual(["b:5", "a:5", "b:3"])
      expect(result.first.nextCursor).toEqual({ triggerId: "b", occurrence: 3 })
      expect(result.second.items.map(position)).toEqual(["a:3"])
      expect(result.second.nextCursor).toBeUndefined()
      expect(result.exact.items).toHaveLength(4)
      expect(result.exact.nextCursor).toBeUndefined()
    })

    it("refuses a history limit that is not a positive safe integer", async () => {
      const errors = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          return yield* Effect.all([
            Effect.flip(store.history({ limit: 0 })),
            Effect.flip(store.history({ limit: -1 })),
            Effect.flip(store.history({ limit: 1.5 }))
          ])
        })
      )
      for (const error of errors) {
        expect(error.code).toBe("invalid_options")
        expect(error.path).toBe("limit")
      }
      expect(errors[0]?.message).toBe("history limit must be a positive safe integer, received 0")
    })

    it("inspects the reservation, run, and buffered occurrence a trigger holds without expiring them", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const registered = yield* store.register({ ...declaration, overlap: "buffer-one" })
          const claim = { triggerId: declaration.id, expectedRevision: registered.revision }
          const empty = yield* store.inspect(declaration.id)
          yield* store.claimFire({ ...claim, occurrence: 1 })
          const reserved = yield* store.inspect(declaration.id)
          yield* store.claimFire({ ...claim, occurrence: 2 })
          yield* store.recordResult({
            triggerId: declaration.id,
            occurrence: 1,
            outcome: "launched",
            runId: "run-1",
            reservationId: (yield* store.inspect(declaration.id)).activeRunId!
          })
          const running = yield* store.inspect(declaration.id)
          yield* TestClock.adjust(reservationLeaseMs + 1)
          const later = yield* store.inspect(declaration.id)
          return { empty, reserved, running, later }
        })
      )
      expect(result.empty).toEqual({})
      expect(result.reserved).toEqual({ activeRunId: expect.stringMatching(/^trigger-reservation:daily:[^:]+:1$/) })
      expect(result.running).toEqual({ activeRunId: "run-1", pendingAt: 2 })
      expect(result.later).toEqual(result.running)
    })

    it("records heartbeats at the store clock and reports the newest host", async () => {
      const result = await run(
        Effect.gen(function*() {
          const store = yield* TriggerStore.TriggerStore
          const none = yield* store.lastHeartbeat()
          yield* store.heartbeat("b")
          const b0 = yield* store.lastHeartbeat()
          yield* store.heartbeat("a")
          const tie0 = yield* store.lastHeartbeat()
          yield* TestClock.adjust(10)
          yield* store.heartbeat("b")
          const b10 = yield* store.lastHeartbeat()
          yield* store.heartbeat("a")
          const tie10 = yield* store.lastHeartbeat()
          return { none, b0, tie0, b10, tie10 }
        })
      )
      expect(result.none).toMatchObject({ _tag: "None" })
      expect(result.b0).toMatchObject({ _tag: "Some", value: { host: "b", tickedAt: 0 } })
      // Equal times fall to the lower host name so the answer is one row.
      expect(result.tie0).toMatchObject({ _tag: "Some", value: { host: "a", tickedAt: 0 } })
      expect(result.b10).toMatchObject({ _tag: "Some", value: { host: "b", tickedAt: 10 } })
      expect(result.tie10).toMatchObject({ _tag: "Some", value: { host: "a", tickedAt: 10 } })
    })
  })
}
