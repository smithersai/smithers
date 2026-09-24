import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { LineageEdge } from "../src/Frame.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

/**
 * A rewind may only run under an exclusive, activated claim on the run and on
 * every detached child it intends to cancel. Each way that arbitration can be
 * lost — an already-claimed row, a stolen activation, a fence lost between the
 * claim and the cancellation — must surface as a typed refusal and must not
 * leave a dangling claim behind.
 */

const owner: OwnerId = { hostId: "test-host", pid: 10, nonce: "rewind-owner" }
const frame = { lineageId: "run/root", seq: 0 } as const

const runError = (method: string, code: RunStore.RunStoreError["code"] = "not_found_row") =>
  new RunStore.RunStoreError({ code, method, message: `${method} failed`, cause: method })

const row = (
  runId: string,
  status: RunStore.RunStatus = "suspended"
): RunStore.RunRow => ({
  runId,
  status,
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: status === "running" ? { hostId: "child-host", pid: 11, nonce: "child-owner" } : null,
  heartbeatAtMs: status === "running" ? 0 : null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}"
})

const baseline = (): MemoryTimeTravelStore.JournalRecord => ({
  runId: "run",
  seq: 0,
  eventId: "event-0",
  lineageId: "run/root",
  payload: { eventType: "baseline", payload: {}, meta: { lineageId: "run/root" } }
})

const edge: LineageEdge = {
  parentRunId: "run",
  parentSeq: 1,
  childRunId: "child",
  kind: "child",
  attached: false
}

const provide = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  store: ReturnType<typeof MemoryTimeTravelStore.make>,
  runs: RunStore.Service
) =>
  program.pipe(
    Effect.provide(Layer.succeed(TimeTravelStore, store)),
    Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
    Effect.provide(Journal.layerNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) })),
    Effect.provide(CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })),
    Effect.provide(
      Layer.succeed(
        Jj.Jj,
        Jj.makeNoop({
          snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }),
          restore: () => Effect.void
        })
      )
    ),
    Effect.provide(
      Layer.succeed(
        EffectHandlerRegistry.EffectHandlerRegistry,
        EffectHandlerRegistry.makeNoop()
      )
    )
  )

const rewind = (
  runs: RunStore.Service,
  options: Partial<Rewind.Options> = {},
  store = MemoryTimeTravelStore.make({ records: [baseline()] })
) =>
  Effect.flip(
    provide(
      Rewind.rewind({ runId: "run", frame, owner, auditId: "audit", ...options }),
      store,
      runs
    )
  )

describe("Rewind run claim arbitration", () => {
  it.effect("refuses a run that is already running", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(RunStore.makeNoop({ get: () => Effect.succeed(row("run", "running")) }))

      expect(failure).toMatchObject({
        code: "busy",
        message: "run run is not available for rewind"
      })
    }))

  it.effect("refuses a terminal run without touching the claim columns", () =>
    Effect.gen(function*() {
      let claims = 0
      const failure = yield* rewind(
        RunStore.makeNoop({
          get: () => Effect.succeed(row("run", "completed")),
          claim: () =>
            Effect.sync(() => {
              claims += 1
              return { _tag: "NotFound" as const }
            })
        })
      )

      expect(claims).toBe(0)
      expect(failure.code).toBe("busy")
    }))

  it.effect("refuses pending or suspended rows with dangling ownership evidence", () =>
    Effect.gen(function*() {
      for (
        const unavailable of [
          { ...row("run", "suspended"), owner, heartbeatAtMs: 1 },
          { ...row("run", "pending"), claim: owner, claimedAtMs: 1 }
        ] satisfies ReadonlyArray<RunStore.RunRow>
      ) {
        let claims = 0
        const failure = yield* rewind(
          RunStore.makeNoop({
            get: () => Effect.succeed(unavailable),
            claim: () =>
              Effect.sync(() => {
                claims += 1
                return { _tag: "Claimed" as const, claimedAtMs: 2 }
              })
          })
        )

        expect(failure).toMatchObject({ code: "busy", message: "run run is not available for rewind" })
        expect(claims).toBe(0)
      }
    }))

  it.effect("maps a missing run row to a typed not_found failure", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(RunStore.makeNoop({ get: () => Effect.fail(runError("get")) }))

      expect(failure).toMatchObject({ code: "not_found", message: "read run failed" })
    }))

  it.effect("maps a run store outage to unknown rather than not_found", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(
        RunStore.makeNoop({ get: () => Effect.fail(runError("get", "persistence_failed")) })
      )

      expect(failure).toMatchObject({ code: "unknown", message: "read run failed" })
    }))

  it.effect("reports a run that disappeared between the read and the claim", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(
        RunStore.makeNoop({
          get: () => Effect.succeed(row("run")),
          claim: () => Effect.succeed({ _tag: "NotFound" as const })
        })
      )

      expect(failure).toMatchObject({ code: "not_found", message: "run run was not found" })
    }))

  it.effect("reports a lost claim race as busy", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(
        RunStore.makeNoop({
          get: () => Effect.succeed(row("run")),
          claim: () => Effect.succeed({ _tag: "AlreadyClaimed" as const })
        })
      )

      expect(failure).toMatchObject({ code: "busy", message: "run run lost the rewind claim" })
    }))

  it.effect("maps claim and activation persistence failures", () =>
    Effect.gen(function*() {
      const scenarios = [
        {
          message: "claim run failed",
          runs: RunStore.makeNoop({
            get: () => Effect.succeed(row("run")),
            claim: () => Effect.fail(runError("claim", "persistence_failed"))
          })
        },
        {
          message: "activate rewind claim failed",
          runs: RunStore.makeNoop({
            get: () => Effect.succeed(row("run")),
            claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 7 }),
            activate: () => Effect.fail(runError("activate", "persistence_failed"))
          })
        }
      ]

      for (const scenario of scenarios) {
        const failure = yield* rewind(scenario.runs)
        expect(failure).toMatchObject({ code: "unknown", message: scenario.message })
      }
    }))

  it.effect("abandons the claim when activation is lost", () =>
    Effect.gen(function*() {
      const abandoned: Array<number> = []
      const failure = yield* rewind(
        RunStore.makeNoop({
          get: () => Effect.succeed(row("run")),
          claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 7 }),
          activate: () => Effect.succeed({ _tag: "SnapshotChanged" as const }),
          abandonClaim: (_runId, _claimant, claimedAtMs) =>
            Effect.sync(() => {
              abandoned.push(claimedAtMs)
              return { _tag: "Abandoned" as const }
            })
        })
      )

      expect(abandoned).toEqual([7])
      expect(failure).toMatchObject({ code: "busy", message: "run run lost the rewind activation" })
    }))

  it.effect("records a rate-limited rewind on its audit and refuses before any archive", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [baseline()] })
      const failure = yield* rewind(
        RunStore.makeNoop({
          get: () => Effect.succeed(row("run")),
          claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 }),
          activate: () => Effect.succeed({ _tag: "Activated" as const }),
          transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
        }),
        { rateLimit: () => Effect.succeed({ allowed: false, detail: { reason: "quota" } }) },
        store
      )

      expect(failure).toMatchObject({
        code: "rate_limited",
        message: "rewind rate limit exceeded for run"
      })
      expect(store.state().audits[0]).toMatchObject({
        status: "failed",
        rateLimit: { reason: "quota" }
      })
      expect(store.state().records).toHaveLength(1)
    }))
})

describe("Rewind detached child cancellation", () => {
  const parentRuns = (
    childOverrides: Partial<RunStore.Service>,
    childRow: RunStore.RunRow = row("child", "suspended")
  ): RunStore.Service =>
    RunStore.makeNoop({
      get: (runId) => runId === "run" ? Effect.succeed(row("run")) : Effect.succeed(childRow),
      claim: (runId, ...rest) =>
        runId === "run"
          ? Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 })
          : (childOverrides.claim?.(runId, ...rest) ?? Effect.succeed({ _tag: "AlreadyClaimed" as const })),
      activate: (runId, ...rest) =>
        runId === "run"
          ? Effect.succeed({ _tag: "Activated" as const })
          : (childOverrides.activate?.(runId, ...rest) ?? Effect.succeed({ _tag: "Activated" as const })),
      abandonClaim: childOverrides.abandonClaim ?? (() => Effect.succeed({ _tag: "Abandoned" as const })),
      steal: childOverrides.steal ?? (() => Effect.succeed({ _tag: "AlreadyClaimed" as const })),
      transitionOwned: (runId, ...rest) =>
        runId === "run"
          ? Effect.succeed({ _tag: "Transitioned" as const })
          : (childOverrides.transitionOwned?.(runId, ...rest) ??
            Effect.succeed({ _tag: "Transitioned" as const }))
    })

  const storeWithChild = () => MemoryTimeTravelStore.make({ records: [baseline()], edges: [edge] })

  const statefulParentAndChild = () => {
    const rows = new Map<string, RunStore.RunRow>([
      ["run", row("run")],
      ["child", { ...row("child"), stateJson: "{\"child\":true}" }]
    ])
    const runs = RunStore.makeNoop({
      get: (runId) => {
        const current = rows.get(runId)
        return current === undefined ? Effect.fail(runError("get")) : Effect.succeed({ ...current })
      },
      claim: (runId, _expected, claimant, nowMs) =>
        Effect.sync(() => {
          const current = rows.get(runId)!
          if (current.status === "running" || current.claim !== null) {
            return { _tag: "AlreadyClaimed" as const }
          }
          rows.set(runId, { ...current, claim: claimant, claimedAtMs: nowMs })
          return { _tag: "Claimed" as const, claimedAtMs: nowMs }
        }),
      activate: (runId, claimant, claimedAtMs) =>
        Effect.sync(() => {
          const current = rows.get(runId)!
          if (current.claim?.nonce !== claimant.nonce || current.claimedAtMs !== claimedAtMs) {
            return { _tag: "ClaimLost" as const }
          }
          rows.set(runId, {
            ...current,
            status: "running",
            owner: claimant,
            heartbeatAtMs: claimedAtMs,
            claim: null,
            claimedAtMs: null
          })
          return { _tag: "Activated" as const }
        }),
      abandonClaim: () => Effect.succeed({ _tag: "Abandoned" as const }),
      heartbeat: (runId, heartbeatOwner) =>
        Effect.succeed(
          rows.get(runId)?.owner?.nonce === heartbeatOwner.nonce
            ? { _tag: "Updated" as const }
            : { _tag: "FenceLost" as const }
        ),
      transitionOwned: (runId, transitionOwner, status, stateJson) =>
        Effect.sync(() => {
          const current = rows.get(runId)!
          if (current.owner?.nonce !== transitionOwner.nonce) return { _tag: "FenceLost" as const }
          rows.set(runId, {
            ...current,
            status,
            stateJson: stateJson ?? current.stateJson,
            owner: null,
            heartbeatAtMs: null,
            claim: null,
            claimedAtMs: null
          })
          return { _tag: "Transitioned" as const }
        })
    })
    return { rows, runs }
  }

  const attachedStore = () =>
    MemoryTimeTravelStore.make({
      records: [baseline(), { runId: "child", seq: 0, eventId: "child-0", payload: {} }],
      edges: [{ ...edge, attached: true }]
    })

  it.effect("persists the child plan and owns the child before the archive hook", () =>
    Effect.gen(function*() {
      const store = attachedStore()
      const { rows, runs } = statefulParentAndChild()
      let pendingAtArchive: ReadonlyArray<string> | undefined
      let childAtArchive: RunStore.RunRow | undefined

      const result = yield* provide(
        Rewind.rewind({
          runId: "run",
          frame,
          owner,
          auditId: "audit-owned-child",
          detachedChildPolicy: "cancel",
          hooks: {
            beforeStep: (step) =>
              Effect.sync(() => {
                if (step !== "archive-and-truncate") return
                pendingAtArchive = (store.state().audits[0]!.detail as Rewind.AuditDetail).pendingChildren
                childAtArchive = { ...rows.get("child")! }
              })
          }
        }),
        store,
        runs
      )

      expect(pendingAtArchive).toEqual(["child"])
      expect(childAtArchive).toMatchObject({
        status: "running",
        owner: { ...owner, nonce: "rewind-owner:rewind-child:child" }
      })
      expect(rows.get("child")).toMatchObject({ status: "cancelled", owner: null })
      expect(result.cancelledChildren).toEqual(["child"])
    }))

  it.effect("restores a claimed child when the archive fails before commit", () =>
    Effect.gen(function*() {
      const store = attachedStore()
      const { rows, runs } = statefulParentAndChild()

      const failure = yield* Effect.flip(
        provide(
          Rewind.rewind({
            runId: "run",
            frame,
            owner,
            auditId: "audit-release-child",
            detachedChildPolicy: "cancel",
            hooks: {
              beforeStep: (step) =>
                step === "archive-and-truncate" ? Effect.fail(new Error("stop before archive")) : Effect.void
            }
          }),
          store,
          runs
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "rewind failed at archive-and-truncate" })
      expect(rows.get("child")).toMatchObject({
        status: "suspended",
        owner: null,
        stateJson: "{\"child\":true}"
      })
      expect(store.state().records.map((record) => record.eventId)).toEqual(["event-0", "child-0"])
    }))

  it.effect("parks pending and dead-running children without retaining the rewind owner", () =>
    Effect.gen(function*() {
      for (const originalStatus of ["pending", "running"] as const) {
        const restoredStatuses: Array<RunStore.RunStatus> = []
        const childRow = row("child", originalStatus)
        const runs = parentRuns(
          {
            claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 }),
            steal: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 }),
            transitionOwned: (_runId, _owner, status) =>
              Effect.sync(() => {
                restoredStatuses.push(status)
                return { _tag: "Transitioned" as const }
              })
          },
          childRow
        )
        const store = attachedStore()

        yield* Effect.flip(
          provide(
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: `audit-release-${originalStatus}-child`,
              detachedChildPolicy: "cancel",
              childLivenessEvidence: (_runId, child, _claimant, nowMs) =>
                Effect.succeed(
                  child.owner === null
                    ? undefined
                    : {
                      expectedOwner: child.owner,
                      checkedAtMs: nowMs,
                      kind: "same-host-pid-dead" as const
                    }
                ),
              hooks: {
                beforeStep: (step) =>
                  step === "archive-and-truncate" ? Effect.fail(new Error("stop before archive")) : Effect.void
              }
            }),
            store,
            runs
          )
        )

        expect(restoredStatuses).toEqual(["suspended"])
      }
    }))

  it.effect("reports every failed claimed-child restoration and keeps the audit open", () =>
    Effect.gen(function*() {
      for (
        const scenario of [
          {
            expected: "restore child child failed",
            transition: Effect.fail(runError("transitionOwned", "persistence_failed"))
          },
          {
            expected: "restore child child returned FenceLost",
            transition: Effect.succeed({ _tag: "FenceLost" as const })
          }
        ]
      ) {
        const store = attachedStore()
        const runs = parentRuns({
          claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 }),
          transitionOwned: () => scenario.transition
        })

        const failure = yield* Effect.flip(
          provide(
            Rewind.rewind({
              runId: "run",
              frame,
              owner,
              auditId: `audit-release-child-${scenario.expected}`,
              detachedChildPolicy: "cancel",
              hooks: {
                beforeStep: (step) =>
                  step === "archive-and-truncate" ? Effect.fail(new Error("stop before archive")) : Effect.void
              }
            }),
            store,
            runs
          )
        )

        expect(failure.message).toContain(scenario.expected)
        expect(store.state().audits[0]).toMatchObject({ status: "in_progress" })
      }
    }))

  it.effect("discloses a child whose evidence is missing instead of failing the rewind", () =>
    Effect.gen(function*() {
      const store = storeWithChild()
      const result = yield* (
        provide(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "audit", detachedChildPolicy: "cancel" }),
          store,
          RunStore.makeNoop({
            get: (runId) => runId === "run" ? Effect.succeed(row("run")) : Effect.fail(runError("get")),
            claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 }),
            activate: () => Effect.succeed({ _tag: "Activated" as const }),
            transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
          })
        )
      )

      expect(result.warnings).toEqual([
        expect.objectContaining({
          childRunId: "child",
          reason: "Detached child evidence is missing; the orphaned lineage edge remains disclosed."
        })
      ])
      expect(result.cancelledChildren).toEqual([])
    }))

  it.effect("refuses to cancel a running child with no liveness probe configured", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(
        parentRuns({}, row("child", "running")),
        { detachedChildPolicy: "cancel" },
        storeWithChild()
      )

      expect(failure).toMatchObject({
        code: "live_child",
        message: "child child is running and has no cancellation evidence"
      })
    }))

  it.effect("refuses to cancel a running child the probe cannot prove dead", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(
        parentRuns({}, row("child", "running")),
        {
          detachedChildPolicy: "cancel",
          childLivenessEvidence: () => Effect.succeed(undefined)
        },
        storeWithChild()
      )

      expect(failure).toMatchObject({ code: "live_child", message: "child child is still live" })
    }))

  it.effect("steals a proven-dead running child under a derived child owner and cancels it", () =>
    Effect.gen(function*() {
      const stolen: Array<{ readonly nonce: string; readonly evidence: LivenessEvidence }> = []
      const cancelled: Array<string> = []
      const store = storeWithChild()

      const result = yield* (
        provide(
          Rewind.rewind({
            runId: "run",
            frame,
            owner,
            auditId: "audit",
            detachedChildPolicy: "cancel",
            childLivenessEvidence: (_childRunId, childRow, childOwner, nowMs) =>
              Effect.succeed({
                expectedOwner: childRow.owner ?? childOwner,
                checkedAtMs: nowMs,
                kind: "cross-host-unreachable-stale"
              })
          }),
          store,
          parentRuns(
            {
              steal: (_runId, _expected, claimant, _nowMs, evidence) =>
                Effect.sync(() => {
                  stolen.push({ nonce: claimant.nonce, evidence })
                  return { _tag: "Claimed" as const, claimedAtMs: 3 }
                }),
              transitionOwned: (runId, _claimant, status) =>
                Effect.sync(() => {
                  cancelled.push(`${runId}:${status}`)
                  return { _tag: "Transitioned" as const }
                })
            },
            row("child", "running")
          )
        )
      )

      expect(stolen[0]?.nonce).toBe("rewind-owner:rewind-child:child")
      expect(cancelled).toEqual(["child:cancelled"])
      expect(result.cancelledChildren).toEqual(["child"])
    }))

  it.effect("refuses when the child cannot be claimed for cancellation", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(
        parentRuns({ claim: () => Effect.succeed({ _tag: "HeartbeatFresh" as const }) }),
        { detachedChildPolicy: "cancel" },
        storeWithChild()
      )

      expect(failure).toMatchObject({
        code: "live_child",
        message: "could not claim child child for cancellation"
      })
    }))

  it.effect("abandons the child claim when its activation is lost", () =>
    Effect.gen(function*() {
      const abandoned: Array<string> = []
      const failure = yield* rewind(
        parentRuns({
          claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 4 }),
          activate: () => Effect.succeed({ _tag: "ClaimLost" as const }),
          abandonClaim: (runId) =>
            Effect.sync(() => {
              abandoned.push(runId)
              return { _tag: "Abandoned" as const }
            })
        }),
        { detachedChildPolicy: "cancel" },
        storeWithChild()
      )

      expect(abandoned).toEqual(["child"])
      expect(failure).toMatchObject({
        code: "live_child",
        message: "child child lost its cancellation claim"
      })
    }))

  it.effect("refuses when the child cancellation fence is lost", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(
        parentRuns({
          claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 4 }),
          transitionOwned: () => Effect.succeed({ _tag: "FenceLost" as const })
        }),
        { detachedChildPolicy: "cancel" },
        storeWithChild()
      )

      expect(failure).toMatchObject({
        code: "live_child",
        message: "child child lost its cancellation fence"
      })
    }))

  it.effect("surfaces a child persistence outage as a typed unknown failure", () =>
    Effect.gen(function*() {
      const failure = yield* rewind(
        parentRuns({ claim: () => Effect.fail(runError("claim", "persistence_failed")) }),
        { detachedChildPolicy: "cancel" },
        storeWithChild()
      )

      expect(failure).toMatchObject({ code: "unknown", message: "claim child child failed" })
    }))

  it.effect("maps every remaining child ownership persistence failure", () =>
    Effect.gen(function*() {
      const scenarios: ReadonlyArray<{
        readonly message: string
        readonly runs: RunStore.Service
        readonly options?: Partial<Rewind.Options>
      }> = [
        {
          message: "activate child child failed",
          runs: parentRuns({
            claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 4 }),
            activate: () => Effect.fail(runError("activate", "persistence_failed"))
          })
        },
        {
          message: "cancel child child failed",
          runs: parentRuns({
            claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 4 }),
            transitionOwned: () => Effect.fail(runError("cancel", "persistence_failed"))
          })
        },
        {
          message: "claim child child failed",
          runs: parentRuns(
            { steal: () => Effect.fail(runError("steal", "persistence_failed")) },
            row("child", "running")
          ),
          options: {
            childLivenessEvidence: (_childRunId, childRow, childOwner, nowMs) =>
              Effect.succeed({
                expectedOwner: childRow.owner ?? childOwner,
                checkedAtMs: nowMs,
                kind: "cross-host-unreachable-stale"
              })
          }
        }
      ]

      for (const scenario of scenarios) {
        const failure = yield* rewind(
          scenario.runs,
          { detachedChildPolicy: "cancel", ...scenario.options },
          storeWithChild()
        )
        expect(failure).toMatchObject({ code: "unknown", message: scenario.message })
      }
    }))
})
