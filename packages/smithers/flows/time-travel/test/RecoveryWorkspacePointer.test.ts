import { expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Runs from "@smthrs/run-store/RunStore"
import * as Cache from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Registry from "../src/internal/EffectHandlerRegistry.ts"
import * as Recovery from "../src/internal/Recovery.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import { error } from "../src/TimeTravelError.ts"
import { type Audit, TimeTravelStore } from "../src/TimeTravelStore.ts"

for (const boundary of ["before-restore", "after-restore"] as const) {
  it(`restores the workspace from the durable image captured ${boundary}`, async () => {
    const owner = { hostId: "probe", pid: 1, nonce: "probe" }
    const frame = { lineageId: "L", seq: 0 }
    const effect = {
      id: "e",
      kind: "workspace",
      tier: "compensable",
      status: "succeeded",
      runId: "r",
      lineageId: "L",
      durableBoundary: true,
      providerStream: false
    }
    const entries = [
      {
        runId: "r",
        seq: 0,
        eventId: "base",
        sourceId: "s",
        sourceSeq: 0,
        emittedAtMs: 0,
        eventType: "baseline",
        payload: {},
        meta: { lineageId: "L" }
      },
      {
        runId: "r",
        seq: 1,
        eventId: "effect",
        sourceId: "s",
        sourceSeq: 1,
        emittedAtMs: 1,
        eventType: "flows.time-travel.effect-boundary",
        payload: { version: 1, effect },
        meta: { lineageId: "L" }
      }
    ] as Array<JournalEvent.Entry>
    const journal = Journal.makeNoop({
      entries: ({ after }) =>
        Effect.succeed({ entries: entries.filter((entry) => entry.seq > (after ?? -1)), hasMore: false })
    })
    let pointer = "original-workspace"
    let status: Runs.RunStatus = "suspended"
    const runs = Runs.makeNoop({
      get: () =>
        Effect.succeed({
          runId: "r",
          status,
          createdAtMs: 0,
          startedAtMs: 0,
          finishedAtMs: null,
          owner: status === "running" ? owner : null,
          heartbeatAtMs: 0,
          claim: null,
          claimedAtMs: null,
          parentRunId: null,
          cancelRequestedAtMs: null,
          stateJson: "{}"
        }),
      claim: () => Effect.succeed({ _tag: "Claimed", claimedAtMs: 0 }),
      activate: () =>
        Effect.sync(() => {
          status = "running"
          return { _tag: "Activated" as const }
        }),
      transitionOwned: (_id, _owner, next) =>
        Effect.sync(() => {
          status = next
          return { _tag: "Transitioned" as const }
        })
    })
    const store = Memory.make({ snapshots: [{ runId: "r", frame, changeId: "target-workspace" }] })
    let crashAudit: Audit | undefined
    let crashPointer = ""
    const capture = Effect.gen(function*() {
      crashAudit = structuredClone((yield* store.pendingAudits())[0])
      crashPointer = pointer
      return yield* Effect.fail(error("unknown", "stop after capturing crash image"))
    })
    const jj = Jj.makeNoop({
      snapshot: () => Effect.succeed({ changeId: pointer }),
      restore: (id) =>
        boundary === "before-restore" && id === "target-workspace"
          ? capture.pipe(Effect.mapError(() => Jj.jjError({ code: "unknown", method: "restore" })))
          : Effect.sync(() => {
            pointer = id
          })
    })
    const provide = <A, E, R>(work: Effect.Effect<A, E, R>, targetStore: TimeTravelStore["Service"]) =>
      work.pipe(
        Effect.provideService(TimeTravelStore, targetStore),
        Effect.provideService(Runs.RunStore, runs),
        Effect.provideService(Journal.Journal, journal),
        Effect.provideService(Jj.Jj, jj),
        Effect.provideService(Registry.EffectHandlerRegistry, Registry.makeNoop()),
        Effect.provideService(Cache.CacheStore, Cache.makeNoop())
      )
    await Effect.runPromise(Effect.exit(provide(
      Rewind.rewind({
        runId: "r",
        frame,
        owner,
        hooks: { beforeStep: (step) => step === "restore-workspace" ? capture : Effect.void }
      }),
      store
    )))
    expect(crashAudit).toBeDefined()
    const recoveredStore = Memory.make()
    await Effect.runPromise(recoveredStore.writeAudit(crashAudit!))
    pointer = crashPointer
    status = "running"
    const outcomes = await Effect.runPromise(
      provide(Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined) }), recoveredStore)
    )
    expect(outcomes).toMatchObject([{ _tag: "RolledBack" }])
    expect(pointer).toBe("original-workspace")
    expect((crashAudit!.detail as Rewind.AuditDetail).compensation?.workspace).toEqual({
      currentChangeId: "original-workspace",
      targetChangeId: "target-workspace"
    })
    expect(
      await Effect.runPromise(provide(
        Recovery.recover({
          owner,
          livenessEvidence: () => Effect.succeed(undefined)
        }),
        recoveredStore
      ))
    ).toEqual([])
  })
}
