import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { Journal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import type { LivenessEvidence, OwnerId } from "@smthrs/run-store/Ownership"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Recovery from "../src/internal/Recovery.ts"
import type { AuditDetail } from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { type Audit, TimeTravelStore } from "../src/TimeTravelStore.ts"
import { row } from "./MemoryHarness.ts"

/**
 * Startup recovery must arbitrate ownership before it touches a run: an
 * unowned suspended run needs no fence, a claimable run is claimed and
 * activated, a live owner is refused, and a dead owner is only stolen from on
 * explicit liveness evidence. Every refusal has to be typed and must leave the
 * persisted run status exactly as it was found.
 */

const owner: OwnerId = { hostId: "recovery-host", pid: 40, nonce: "recovery-owner" }
const stranger: OwnerId = { hostId: "other-host", pid: 41, nonce: "stranger" }
const frame = { lineageId: "run/root", seq: 0 } as const

const runError = (method: string) =>
  new RunStore.RunStoreError({
    code: "persistence_failed",
    method,
    message: `${method} failed`,
    cause: method
  })

const baseRow = (overrides: Partial<RunStore.RunRow>): RunStore.RunRow =>
  row({ status: "running", heartbeatAtMs: 0, stateJson: "{\"cursor\":7}", ...overrides })

const auditRow = (detail?: unknown): Audit => ({
  id: "audit",
  runId: "run",
  frame,
  status: "in_progress",
  detail: detail === undefined
    ? ({
      version: 1,
      phase: "archive_committed",
      originalStatus: "suspended",
      suffixCount: 1,
      suffixTailSeq: 1,
      warnings: [],
      cancelledChildren: []
    } satisfies AuditDetail)
    : detail
})

/**
 * A run double that can actually be claimed.
 *
 * Recovery claims every row it acts on, including a suspended unowned one: the
 * rollback it may run reverses external effects and restores a jj workspace,
 * and doing that unfenced let a concurrent engine claim the run and start
 * executing it mid-rollback. A double that refuses every claim therefore no
 * longer describes any reachable state.
 */
const claimable = (
  initial: RunStore.RunRow,
  overrides: Partial<RunStore.Service> = {}
): RunStore.Service & { readonly state: () => RunStore.RunRow } => {
  let row = { ...initial }
  const service = RunStore.makeNoop({
    get: () => Effect.succeed({ ...row }),
    claim: (_runId, _expected, claimant, nowMs) =>
      Effect.sync(() => {
        if (row.status === "running" || row.claim !== null) return { _tag: "HeartbeatFresh" as const }
        row = { ...row, claim: claimant, claimedAtMs: nowMs }
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: (_runId, claimant, claimedAtMs) =>
      Effect.sync(() => {
        if (row.claim?.nonce !== claimant.nonce || row.claimedAtMs !== claimedAtMs) {
          return { _tag: "ClaimLost" as const }
        }
        row = {
          ...row,
          status: "running",
          owner: claimant,
          heartbeatAtMs: claimedAtMs,
          claim: null,
          claimedAtMs: null
        }
        return { _tag: "Activated" as const }
      }),
    heartbeat: () => Effect.succeed({ _tag: "Updated" as const }),
    transitionOwned: (_runId, transitionOwner, status, stateJson) =>
      Effect.gen(function*() {
        if (status === "pending") {
          return yield* Effect.fail(
            new RunStore.RunStoreError({
              code: "invalid_run",
              method: "transitionOwned",
              message: "transitionOwned cannot target pending",
              cause: status
            })
          )
        }
        if (row.owner?.nonce !== transitionOwner.nonce) return { _tag: "FenceLost" as const }
        row = {
          ...row,
          status,
          stateJson: stateJson ?? row.stateJson,
          owner: null,
          heartbeatAtMs: null,
          claim: null,
          claimedAtMs: null
        }
        return { _tag: "Transitioned" as const }
      }),
    ...overrides
  })
  return Object.assign(service, { state: () => ({ ...row }) })
}

const emptyJournal = Journal.makeNoop({
  entries: () => Effect.succeed({ entries: [], hasMore: false })
})

const seeded = (audit: Audit = auditRow()) => {
  const store = MemoryTimeTravelStore.make()
  Effect.runSync(store.writeAudit(audit))
  return store
}

const runRecovery = (
  runs: RunStore.Service,
  options: {
    readonly audit?: Audit
    readonly journal?: Journal.Service
    readonly livenessEvidence?: Recovery.Options["livenessEvidence"]
    readonly registry?: EffectHandlerRegistry.Service
    readonly jj?: Jj.Jj
    /** Reuse one store across passes; `audit` is then already in it. */
    readonly store?: ReturnType<typeof MemoryTimeTravelStore.make>
  } = {}
) => {
  const store = options.store ?? seeded(options.audit)
  const jj = options.jj ?? Jj.makeNoop({
    snapshot: () => Effect.succeed({ changeId: "current" }),
    restore: () => Effect.void
  })
  return Effect.map(
    Recovery.recover({ owner, livenessEvidence: options.livenessEvidence ?? (() => Effect.succeed(undefined)) }).pipe(
      Effect.provide(Layer.succeed(TimeTravelStore, store)),
      Effect.provide(Layer.succeed(RunStore.RunStore, runs)),
      Effect.provide(Layer.succeed(Journal.Journal, options.journal ?? emptyJournal)),
      Effect.provide(Layer.succeed(Jj.Jj, jj)),
      Effect.provide(
        Layer.succeed(
          EffectHandlerRegistry.EffectHandlerRegistry,
          options.registry ?? EffectHandlerRegistry.makeNoop()
        )
      )
    ),
    (outcomes) => ({ outcomes, audits: store.state().audits })
  )
}

describe("Recovery ownership arbitration", () => {
  it.effect("rolls an originally pending run back to suspended and closes the audit", () =>
    Effect.gen(function*() {
      const runs = claimable(baseRow({ status: "pending", owner: null, heartbeatAtMs: null }))
      const { audits, outcomes } = yield* runRecovery(runs, {
        audit: auditRow(
          {
            version: 1,
            phase: "audit_written",
            originalStatus: "pending",
            suffixCount: 0,
            warnings: [],
            cancelledChildren: []
          } satisfies AuditDetail
        )
      })

      expect(outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
      expect(runs.state()).toMatchObject({
        status: "suspended",
        owner: null,
        heartbeatAtMs: null,
        claim: null,
        stateJson: "{\"cursor\":7}"
      })
      expect(audits[0]).toMatchObject({ status: "failed", detail: { phase: "rolled_back" } })
    }))

  it.effect("releases an originally pending run to suspended after a recovery failure", () =>
    Effect.gen(function*() {
      const runs = claimable(baseRow({ status: "pending", owner: null, heartbeatAtMs: null }))
      const { audits, outcomes } = yield* runRecovery(runs, {
        audit: auditRow(
          {
            version: 1,
            phase: "compensated",
            originalStatus: "pending",
            suffixCount: 1,
            warnings: [],
            cancelledChildren: []
          } satisfies AuditDetail
        ),
        journal: Journal.makeNoop()
      })

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: "could not inspect archive commit for audit" }
      })
      expect(runs.state()).toMatchObject({
        status: "suspended",
        owner: null,
        heartbeatAtMs: null,
        claim: null,
        stateJson: "{\"cursor\":7}"
      })
      expect(audits[0]).toMatchObject({ status: "failed", detail: { phase: "terminal_failure" } })
    }))

  it.effect("claims an unowned suspended run and gives the fence back when it finishes", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const runs = claimable(
        baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }),
        {}
      )
      const traced = RunStore.makeNoop({
        ...runs,
        claim: (...args) => Effect.sync(() => calls.push("claim")).pipe(Effect.andThen(runs.claim(...args))),
        activate: (...args) => Effect.sync(() => calls.push("activate")).pipe(Effect.andThen(runs.activate(...args))),
        transitionOwned: (...args) =>
          Effect.sync(() => calls.push("transitionOwned")).pipe(Effect.andThen(runs.transitionOwned(...args)))
      })

      const { audits, outcomes } = yield* runRecovery(traced)

      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
      expect(calls).toEqual(["claim", "activate", "transitionOwned"])
      expect(runs.state()).toMatchObject({ status: "suspended", owner: null })
      expect(audits[0]).toMatchObject({ status: "completed", detail: { phase: "completed" } })
    }))

  it.effect("reuses an already-held fence when the run is running under this owner", () =>
    Effect.gen(function*() {
      let transitions = 0
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "running", owner })),
        transitionOwned: () =>
          Effect.sync(() => {
            transitions += 1
            return { _tag: "Transitioned" as const }
          })
      })

      const { outcomes } = yield* runRecovery(runs)

      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
      expect(transitions).toBe(1)
    }))

  it.effect("claims and activates a pending run before recovering it", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "pending" })),
        claim: (_runId, _expected, claimant) =>
          Effect.sync(() => {
            calls.push(`claim:${claimant.nonce}`)
            return { _tag: "Claimed" as const, claimedAtMs: 5 }
          }),
        activate: (_runId, _claimant, claimedAtMs) =>
          Effect.sync(() => {
            calls.push(`activate:${claimedAtMs}`)
            return { _tag: "Activated" as const }
          }),
        transitionOwned: () =>
          Effect.sync(() => {
            calls.push("transitionOwned")
            return { _tag: "Transitioned" as const }
          })
      })

      const { outcomes } = yield* runRecovery(runs)

      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
      expect(calls).toEqual(["claim:recovery-owner", "activate:5", "transitionOwned"])
    }))

  it.effect("drains a compensated audit's persisted child plan when its archive committed", () =>
    Effect.gen(function*() {
      const childRunId = "pending-child"
      const rows = new Map<string, RunStore.RunRow>([
        ["run", baseRow({ status: "suspended", owner: null, heartbeatAtMs: null })],
        [childRunId, { ...baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }), runId: childRunId }]
      ])
      const runs = RunStore.makeNoop({
        get: (runId) => Effect.succeed({ ...rows.get(runId)! }),
        claim: (runId, _expected, claimant, nowMs) =>
          Effect.sync(() => {
            const current = rows.get(runId)!
            if (current.status === "running" || current.claim !== null) {
              return { _tag: "HeartbeatFresh" as const }
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
        transitionOwned: (runId, transitionOwner, status) =>
          Effect.sync(() => {
            const current = rows.get(runId)!
            if (current.owner?.nonce !== transitionOwner.nonce) return { _tag: "FenceLost" as const }
            rows.set(runId, {
              ...current,
              status,
              owner: null,
              heartbeatAtMs: null,
              claim: null,
              claimedAtMs: null
            })
            return { _tag: "Transitioned" as const }
          })
      })
      const store = MemoryTimeTravelStore.make({
        records: [
          { runId: "run", seq: 0, eventId: "event-0", payload: {} },
          { runId: "run", seq: 1, eventId: "event-1", payload: {} }
        ],
        runOwners: new Map([["run", owner]])
      })
      yield* store.archiveAndTruncate("run", frame, [], owner)
      yield* store.writeAudit(auditRow(
        {
          version: 1,
          phase: "compensated",
          originalStatus: "suspended",
          suffixCount: 1,
          suffixTailSeq: 1,
          warnings: [],
          cancelledChildren: [],
          pendingChildren: [childRunId]
        } satisfies AuditDetail
      ))

      const first = yield* runRecovery(runs, { store })

      expect(first.outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
      expect(rows.get(childRunId)).toMatchObject({ status: "cancelled", owner: null })
      expect(first.audits[0]).toMatchObject({
        status: "completed",
        detail: { pendingChildren: [], cancelledChildren: [childRunId] }
      })

      const second = yield* runRecovery(runs, { store })
      expect(second.outcomes).toEqual([])
      expect(rows.get(childRunId)).toMatchObject({ status: "cancelled", owner: null })
    }))

  it.effect("resolves a pending child that is already gone or already terminal", () =>
    Effect.gen(function*() {
      // Draining is a resumption, not a new decision: a child a previous pass
      // already cancelled, or one whose row is gone, is resolved rather than
      // retried, so the audit closes instead of looping forever.
      const parent = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))
      const runs = RunStore.makeNoop({
        ...parent,
        get: (runId) =>
          runId === "run"
            ? parent.get(runId)
            : runId === "gone-child"
            ? Effect.fail(
              new RunStore.RunStoreError({
                code: "not_found_row",
                method: "get",
                message: "run gone-child was not found",
                cause: runId
              })
            )
            : Effect.succeed({ ...baseRow({ status: "cancelled", owner: null, heartbeatAtMs: null }), runId })
      })
      const store = seeded(auditRow(
        {
          version: 1,
          phase: "archive_committed",
          originalStatus: "suspended",
          suffixCount: 1,
          suffixTailSeq: 1,
          warnings: [],
          cancelledChildren: [],
          pendingChildren: ["gone-child", "terminal-child"]
        } satisfies AuditDetail
      ))

      const result = yield* runRecovery(runs, { store })

      expect(result.outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
      expect(result.audits[0]).toMatchObject({
        status: "completed",
        detail: { pendingChildren: [], cancelledChildren: [] }
      })
    }))

  it.effect("keeps a non-busy failure pending when acquired ownership cannot be returned", () =>
    Effect.gen(function*() {
      const childRunId = "release-child"
      const store = seeded(auditRow(
        {
          version: 1,
          phase: "archive_committed",
          originalStatus: "suspended",
          suffixCount: 1,
          suffixTailSeq: 1,
          warnings: [],
          cancelledChildren: [],
          pendingChildren: [childRunId]
        } satisfies AuditDetail
      ))
      const firstRuns = RunStore.makeNoop({
        get: (runId) =>
          runId === "run"
            ? Effect.succeed(baseRow({ status: "running", owner }))
            : Effect.fail(runError("read child")),
        transitionOwned: () => Effect.fail(runError("release ownership"))
      })

      const first = yield* runRecovery(firstRuns, { store })

      expect(first.outcomes[0]).toMatchObject({
        _tag: "Busy",
        error: { code: "unknown", cause: { release: "release ownership failed" } }
      })
      const firstMessage = first.outcomes[0]?._tag === "Busy" ? first.outcomes[0].error.message : ""
      expect(firstMessage).toContain(`read pending child ${childRunId} failed`)
      expect(firstMessage).toContain("could not give ownership back")
      expect(firstMessage).toContain("release ownership failed")
      expect(first.audits[0]).toMatchObject({
        status: "in_progress",
        detail: { pendingChildren: [childRunId] }
      })

      const parent = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))
      const secondRuns = RunStore.makeNoop({
        ...parent,
        get: (runId) =>
          runId === "run"
            ? parent.get(runId)
            : Effect.succeed({
              ...baseRow({ status: "cancelled", owner: null, heartbeatAtMs: null }),
              runId
            })
      })
      const second = yield* runRecovery(secondRuns, { store })

      expect(second.outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
      expect(second.audits[0]).toMatchObject({ status: "completed", detail: { phase: "completed" } })
    }))

  it.effect("propagates a pending child read failure that is not a missing row", () =>
    Effect.gen(function*() {
      const parent = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))
      const runs = RunStore.makeNoop({
        ...parent,
        get: (runId) => runId === "run" ? parent.get(runId) : Effect.fail(runError("get"))
      })
      const store = seeded(auditRow(
        {
          version: 1,
          phase: "archive_committed",
          originalStatus: "suspended",
          suffixCount: 1,
          suffixTailSeq: 1,
          warnings: [],
          cancelledChildren: [],
          pendingChildren: ["unreadable-child"]
        } satisfies AuditDetail
      ))

      const result = yield* runRecovery(runs, { store })

      expect(result.outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: "read pending child unreadable-child failed" }
      })
    }))

  for (
    const scenario of [
      {
        name: "loses the child claim before activation",
        overrides: { activate: () => Effect.succeed({ _tag: "ClaimLost" as const }) },
        message: "child stuck-child lost its cancellation claim"
      },
      {
        name: "loses the child fence before cancellation",
        overrides: { transitionOwned: () => Effect.succeed({ _tag: "FenceLost" as const }) },
        message: "child stuck-child lost its cancellation fence"
      }
    ] as const
  ) {
    it.effect(`leaves the audit pending when recovery ${scenario.name}`, () =>
      Effect.gen(function*() {
        const parent = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))
        const runs = RunStore.makeNoop({
          ...parent,
          get: (runId) =>
            runId === "run"
              ? parent.get(runId)
              : Effect.succeed({ ...baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }), runId }),
          claim: (runId, ...args) =>
            runId === "run"
              ? parent.claim(runId, ...args)
              : Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 5 }),
          abandonClaim: () => Effect.succeed({ _tag: "Abandoned" as const }),
          activate: (runId, ...args) =>
            runId === "run"
              ? parent.activate(runId, ...args)
              : ("activate" in scenario.overrides
                ? scenario.overrides.activate()
                : Effect.succeed({ _tag: "Activated" as const })),
          transitionOwned: (runId, ...args) =>
            runId === "run"
              ? parent.transitionOwned(runId, ...args)
              : ("transitionOwned" in scenario.overrides
                ? scenario.overrides.transitionOwned()
                : Effect.succeed({ _tag: "Transitioned" as const }))
        })
        const store = seeded(auditRow(
          {
            version: 1,
            phase: "archive_committed",
            originalStatus: "suspended",
            suffixCount: 1,
            suffixTailSeq: 1,
            warnings: [],
            cancelledChildren: [],
            pendingChildren: ["stuck-child"]
          } satisfies AuditDetail
        ))

        const result = yield* runRecovery(runs, { store })

        expect(result.outcomes[0]).toMatchObject({
          _tag: "Busy",
          error: { code: "busy", message: scenario.message }
        })
        expect(result.audits[0]).toMatchObject({
          status: "in_progress",
          detail: { pendingChildren: ["stuck-child"] }
        })
      }))
  }

  for (
    const scenario of [
      { name: "claim", method: "claim" as const, message: "claim pending child failing-child failed" },
      { name: "activation", method: "activate" as const, message: "activate pending child failing-child failed" },
      {
        name: "cancellation",
        method: "transitionOwned" as const,
        message: "cancel pending child failing-child failed"
      }
    ] as const
  ) {
    it.effect(`maps a pending child ${scenario.name} persistence failure`, () =>
      Effect.gen(function*() {
        const parent = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))
        const child = (method: "claim" | "activate" | "transitionOwned") =>
          scenario.method === method
            ? Effect.fail(runError(method))
            : method === "claim"
            ? Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 5 })
            : method === "activate"
            ? Effect.succeed({ _tag: "Activated" as const })
            : Effect.succeed({ _tag: "Transitioned" as const })
        const runs = RunStore.makeNoop({
          ...parent,
          get: (runId) =>
            runId === "run"
              ? parent.get(runId)
              : Effect.succeed({ ...baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }), runId }),
          claim: (runId, ...args) => runId === "run" ? parent.claim(runId, ...args) : child("claim") as never,
          activate: (runId, ...args) => runId === "run" ? parent.activate(runId, ...args) : child("activate") as never,
          transitionOwned: (runId, ...args) =>
            runId === "run" ? parent.transitionOwned(runId, ...args) : child("transitionOwned") as never
        })
        const store = seeded(auditRow(
          {
            version: 1,
            phase: "archive_committed",
            originalStatus: "suspended",
            suffixCount: 1,
            suffixTailSeq: 1,
            warnings: [],
            cancelledChildren: [],
            pendingChildren: ["failing-child"]
          } satisfies AuditDetail
        ))

        const result = yield* runRecovery(runs, { store })

        expect(result.outcomes[0]).toMatchObject({
          _tag: "Failed",
          error: { code: "unknown", message: scenario.message }
        })
      }))
  }

  it.effect("leaves a committed audit pending when a remaining child cannot be claimed", () =>
    Effect.gen(function*() {
      const childRunId = "busy-child"
      const store = seeded(auditRow(
        {
          version: 1,
          phase: "archive_committed",
          originalStatus: "suspended",
          suffixCount: 1,
          suffixTailSeq: 1,
          warnings: [],
          cancelledChildren: [],
          pendingChildren: [childRunId]
        } satisfies AuditDetail
      ))
      // The parent run claims normally; only the child refuses, so the pass
      // gets as far as the cancellation it cannot finish.
      const parent = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))
      const runs = RunStore.makeNoop({
        ...parent,
        get: (runId) =>
          runId === "run"
            ? parent.get(runId)
            : Effect.succeed({
              ...baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }),
              runId
            }),
        claim: (runId, ...args) =>
          runId === "run"
            ? parent.claim(runId, ...args)
            : Effect.succeed({ _tag: "SnapshotChanged" as const })
      })

      const result = yield* runRecovery(runs, { store })

      expect(result.outcomes[0]).toMatchObject({
        _tag: "Busy",
        error: { code: "busy", message: `child ${childRunId} could not be claimed for cancellation` }
      })
      expect(result.audits[0]).toMatchObject({
        status: "in_progress",
        detail: { pendingChildren: [childRunId] }
      })
    }))

  it.effect("claims an unowned suspended run before rollback and restores it afterwards", () =>
    Effect.gen(function*() {
      const entered = Effect.runSync(Deferred.make<void>())
      const release = Effect.runSync(Deferred.make<void>())
      let current = baseRow({ status: "suspended", owner: null, heartbeatAtMs: null })
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed({ ...current }),
        claim: (_runId, _expected, claimant, nowMs) =>
          Effect.sync(() => {
            if (current.status === "running" || current.claim !== null) {
              return { _tag: "HeartbeatFresh" as const }
            }
            current = { ...current, claim: claimant, claimedAtMs: nowMs }
            return { _tag: "Claimed" as const, claimedAtMs: nowMs }
          }),
        activate: (_runId, claimant, claimedAtMs) =>
          Effect.sync(() => {
            if (current.claim?.nonce !== claimant.nonce || current.claimedAtMs !== claimedAtMs) {
              return { _tag: "ClaimLost" as const }
            }
            current = {
              ...current,
              status: "running",
              owner: claimant,
              heartbeatAtMs: claimedAtMs,
              claim: null,
              claimedAtMs: null
            }
            return { _tag: "Activated" as const }
          }),
        heartbeat: () => Effect.succeed({ _tag: "Updated" as const }),
        transitionOwned: (_runId, transitionOwner, status, stateJson) =>
          Effect.sync(() => {
            if (current.owner?.nonce !== transitionOwner.nonce) return { _tag: "FenceLost" as const }
            current = {
              ...current,
              status,
              stateJson: stateJson ?? current.stateJson,
              owner: null,
              heartbeatAtMs: null,
              claim: null,
              claimedAtMs: null
            }
            return { _tag: "Transitioned" as const }
          })
      })
      const compensation = {
        handlerReceipts: [{
          id: "send:rollback",
          effect: {
            id: "send",
            kind: "send",
            tier: "irreversible",
            status: "succeeded",
            runId: "run",
            lineageId: frame.lineageId,
            seq: 1,
            durableBoundary: true,
            providerStream: false
          },
          data: { value: "sent" }
        }]
      } as const
      const store = seeded(auditRow(
        {
          version: 1,
          phase: "compensated",
          originalStatus: "suspended",
          suffixCount: 1,
          suffixTailSeq: 1,
          compensation,
          warnings: [],
          cancelledChildren: []
        } satisfies AuditDetail
      ))
      const registry = Effect.runSync(EffectHandlerRegistry.make([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "message residue",
        revert: () => Effect.succeed({ value: "sent" }),
        rollback: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release))
          )
      }]))
      const suffixJournal = Journal.makeNoop({
        entries: () => Effect.succeed({ entries: [{ seq: 1 }] as never, hasMore: false })
      })
      const fiber = yield* Effect.forkChild(
        runRecovery(runs, {
          store,
          registry,
          journal: suffixJournal
        }),
        { startImmediately: true }
      )

      yield* Deferred.await(entered)
      expect(current).toMatchObject({ status: "running", owner })
      const concurrent = yield* runs.claim(
        "run",
        {
          status: current.status,
          owner: current.owner,
          heartbeatAtMs: current.heartbeatAtMs
        },
        stranger,
        99
      )
      expect(concurrent._tag).not.toBe("Claimed")
      yield* Deferred.succeed(release, undefined)
      const result = yield* Fiber.join(fiber)

      expect(result.outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
      expect(current).toMatchObject({ status: "suspended", owner: null, claim: null })
    }))

  it.effect("maps claim and activation persistence failures into terminal outcomes", () =>
    Effect.gen(function*() {
      const scenarios = [
        {
          message: "claim recovery run failed",
          runs: RunStore.makeNoop({
            get: () => Effect.succeed(baseRow({ status: "pending" })),
            claim: () => Effect.fail(runError("claim"))
          })
        },
        {
          message: "activate recovery run failed",
          runs: RunStore.makeNoop({
            get: () => Effect.succeed(baseRow({ status: "pending" })),
            claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 4 }),
            activate: () => Effect.fail(runError("activate"))
          })
        }
      ]

      for (const scenario of scenarios) {
        const { outcomes } = yield* runRecovery(scenario.runs)
        expect(outcomes[0]).toMatchObject({
          _tag: "Failed",
          error: { code: "unknown", message: scenario.message }
        })
      }
    }))

  it.effect("refuses a run that already carries an active claim", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "pending", claim: stranger, claimedAtMs: 3 }))
      })

      const { audits, outcomes } = yield* runRecovery(runs)

      expect(outcomes[0]).toMatchObject({
        _tag: "Busy",
        error: { code: "busy", message: "run run has an active claim" }
      })
      expect(audits[0]).toMatchObject({ status: "in_progress", detail: { phase: "archive_committed" } })
    }))

  it.effect("reports a lost claim race as busy without activating", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "pending" })),
        claim: () => Effect.succeed({ _tag: "SnapshotChanged" as const })
      })

      const { outcomes } = yield* runRecovery(runs)

      expect(outcomes[0]).toMatchObject({
        _tag: "Busy",
        error: { code: "busy", message: "run run could not be claimed for recovery" }
      })
    }))

  it.effect("abandons its claim when activation loses the race", () =>
    Effect.gen(function*() {
      const abandoned: Array<number> = []
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "pending" })),
        claim: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 9 }),
        activate: () => Effect.succeed({ _tag: "ClaimLost" as const }),
        abandonClaim: (_runId, _claimant, claimedAtMs) =>
          Effect.sync(() => {
            abandoned.push(claimedAtMs)
            return { _tag: "Abandoned" as const }
          })
      })

      const { outcomes } = yield* runRecovery(runs)

      expect(abandoned).toEqual([9])
      expect(outcomes[0]).toMatchObject({
        _tag: "Busy",
        error: { code: "busy", message: "run run lost its recovery claim" }
      })
    }))

  it.effect("refuses to steal when the probe cannot prove the owner is dead", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })),
        steal: () => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: 1 })
      })

      const { outcomes } = yield* runRecovery(runs, { livenessEvidence: () => Effect.succeed(undefined) })

      expect(outcomes[0]).toMatchObject({
        _tag: "Busy",
        error: { code: "busy", message: "run run is still live" }
      })
    }))

  it.effect("steals from a proven-dead owner and recovers under the new fence", () =>
    Effect.gen(function*() {
      const stolen: Array<LivenessEvidence> = []
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })),
        steal: (_runId, _expected, _claimant, _nowMs, evidence) =>
          Effect.sync(() => {
            stolen.push(evidence)
            return { _tag: "Claimed" as const, claimedAtMs: 12 }
          }),
        activate: () => Effect.succeed({ _tag: "Activated" as const }),
        transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
      })

      const { outcomes } = yield* runRecovery(runs, {
        livenessEvidence: (audit, row, claimant, nowMs) =>
          Effect.succeed({
            expectedOwner: row.owner ?? claimant,
            checkedAtMs: nowMs,
            kind: audit.runId === "run" ? "cross-host-unreachable-stale" : "same-host-pid-dead"
          })
      })

      expect(stolen).toEqual([
        expect.objectContaining({ expectedOwner: stranger, kind: "cross-host-unreachable-stale" })
      ])
      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
    }))

  // A crash mid-rewind leaves the run `running` under the dead incarnation's
  // owner. Marking that audit `failed` removed it from `pendingAudits`
  // forever, so a rewind interrupted in `compensated` — jj already restored,
  // tier-3 effects already reverted, journal suffix NOT yet truncated — could
  // never be rolled back by any later pass. A busy refusal is a "not yet",
  // so the audit stays exactly as the crash left it.
  it.effect("leaves a busy audit untouched so a later pass still rolls the rewind back", () =>
    Effect.gen(function*() {
      const store = seeded(
        auditRow(
          {
            version: 1,
            phase: "compensated",
            originalStatus: "suspended",
            suffixCount: 1,
            suffixTailSeq: 1,
            warnings: [],
            cancelledChildren: []
          } satisfies AuditDetail
        )
      )
      const suffixJournal = Journal.makeNoop({
        entries: () =>
          Effect.succeed({
            entries: [
              {
                runId: "run",
                seq: 1,
                eventId: "event-1",
                sourceId: "recovery",
                sourceSeq: 1,
                emittedAtMs: 1,
                eventType: "suffix",
                payload: {},
                meta: {}
              }
            ] as never,
            hasMore: false
          })
      })
      let ownerAlive = true
      const settled = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))
      const runs = RunStore.makeNoop({
        ...settled,
        get: () =>
          ownerAlive
            ? Effect.succeed(baseRow({ status: "running", owner: stranger }))
            : settled.get("run")
      })

      const first = yield* runRecovery(runs, { store, journal: suffixJournal })
      expect(first.outcomes).toMatchObject([{ _tag: "Busy", auditId: "audit" }])
      expect(first.audits[0]).toMatchObject({ status: "in_progress", detail: { phase: "compensated" } })

      // The owner's process is gone; the audit is still pending, so the next
      // pass picks it up and finishes the rollback the crash left behind.
      ownerAlive = false
      const second = yield* runRecovery(runs, { store, journal: suffixJournal })
      expect(second.outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
      expect(second.audits[0]).toMatchObject({ status: "failed", detail: { phase: "rolled_back" } })
    }))

  it.effect("maps a failed ownership steal into a terminal outcome", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })),
        steal: () => Effect.fail(runError("steal"))
      })

      const { outcomes } = yield* runRecovery(runs, {
        livenessEvidence: (_audit, row, claimant, nowMs) =>
          Effect.succeed({
            expectedOwner: row.owner ?? claimant,
            checkedAtMs: nowMs,
            kind: "cross-host-unreachable-stale"
          })
      })

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: "steal recovery run failed" }
      })
    }))

  it.effect("propagates a missing run row as a typed not_found terminal failure", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        get: () =>
          Effect.fail(
            new RunStore.RunStoreError({
              code: "not_found_row",
              method: "get",
              message: "no such run",
              cause: undefined
            })
          )
      })

      const { outcomes } = yield* runRecovery(runs)

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "not_found", message: "read recovery run failed" }
      })
    }))

  it.effect("records a terminal failure when the fence is lost mid-recovery", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "running", owner })),
        transitionOwned: () => Effect.succeed({ _tag: "FenceLost" as const })
      })

      const { audits, outcomes } = yield* runRecovery(runs)

      expect(outcomes[0]).toMatchObject({
        _tag: "Busy",
        error: { code: "busy" }
      })
      expect(outcomes[0]?._tag === "Busy" ? outcomes[0].error.message : "").toContain(
        "run run lost its recovery fence"
      )
      expect(audits[0]).toMatchObject({ status: "in_progress", detail: { phase: "archive_committed" } })
    }))

  it.effect("maps suspension and rollback transition persistence failures", () =>
    Effect.gen(function*() {
      const finish = yield* runRecovery(
        RunStore.makeNoop({
          get: () => Effect.succeed(baseRow({ status: "running", owner })),
          transitionOwned: () => Effect.fail(runError("finish"))
        })
      )
      const rollback = yield* runRecovery(
        RunStore.makeNoop({
          get: () => Effect.succeed(baseRow({ status: "running", owner })),
          transitionOwned: () => Effect.fail(runError("restore"))
        }),
        {
          audit: auditRow(
            {
              version: 1,
              phase: "compensated",
              originalStatus: "pending",
              suffixCount: 1,
              warnings: [],
              cancelledChildren: []
            } satisfies AuditDetail
          ),
          journal: Journal.makeNoop({
            entries: () =>
              Effect.succeed({
                entries: [{ seq: 1 }] as never,
                hasMore: false
              })
          })
        }
      )

      expect(finish.outcomes[0]).toMatchObject({ _tag: "Busy", error: { code: "unknown" } })
      expect(finish.outcomes[0]?._tag === "Busy" ? finish.outcomes[0].error.message : "").toContain(
        "finish recovered suspension failed"
      )
      expect(rollback.outcomes[0]).toMatchObject({ _tag: "Busy", error: { code: "unknown" } })
      expect(rollback.outcomes[0]?._tag === "Busy" ? rollback.outcomes[0].error.message : "").toContain(
        "restore recovered run failed"
      )
    }))

  it.effect("records a terminal failure when the rollback fence is lost", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "running", owner })),
        transitionOwned: () => Effect.succeed({ _tag: "FenceLost" as const })
      })

      const { outcomes } = yield* runRecovery(runs, {
        audit: auditRow(
          {
            version: 1,
            phase: "compensated",
            originalStatus: "suspended",
            suffixCount: 1,
            suffixTailSeq: 1,
            warnings: [],
            cancelledChildren: []
          } satisfies AuditDetail
        ),
        journal: Journal.makeNoop({
          entries: () =>
            Effect.succeed({
              entries: [
                {
                  runId: "run",
                  seq: 1,
                  eventId: "event-1",
                  sourceId: "recovery",
                  sourceSeq: 1,
                  emittedAtMs: 1,
                  eventType: "suffix",
                  payload: {},
                  meta: {}
                }
              ] as never,
              hasMore: false
            })
        })
      })

      expect(outcomes[0]).toMatchObject({
        _tag: "Busy",
        error: { code: "busy" }
      })
      expect(outcomes[0]?._tag === "Busy" ? outcomes[0].error.message : "").toContain(
        "run run lost its rollback fence"
      )
    }))

  it.effect("rolls back without consulting the journal when the rewind archived nothing", () =>
    Effect.gen(function*() {
      let entryQueries = 0
      const runs = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))

      const { audits, outcomes } = yield* runRecovery(runs, {
        audit: auditRow(
          {
            version: 1,
            phase: "compensated",
            originalStatus: "suspended",
            suffixCount: 0,
            warnings: [],
            cancelledChildren: []
          } satisfies AuditDetail
        ),
        journal: Journal.makeNoop({
          entries: () =>
            Effect.sync(() => {
              entryQueries += 1
              return { entries: [], hasMore: false }
            })
        })
      })

      expect(entryQueries).toBe(0)
      expect(outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
      expect(audits[0]).toMatchObject({ status: "failed", detail: { phase: "rolled_back" } })
    }))

  it.effect("treats an already-completed protocol phase as committed", () =>
    Effect.gen(function*() {
      let entryQueries = 0
      const { outcomes } = yield* runRecovery(
        claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null })),
        {
          audit: auditRow(
            {
              version: 1,
              phase: "completed",
              originalStatus: "suspended",
              suffixCount: 1,
              warnings: [],
              cancelledChildren: []
            } satisfies AuditDetail
          ),
          journal: Journal.makeNoop({
            entries: () =>
              Effect.sync(() => {
                entryQueries += 1
                return { entries: [], hasMore: false }
              })
          })
        }
      )

      expect(outcomes).toEqual([{ _tag: "Completed", auditId: "audit" }])
      expect(entryQueries).toBe(0)
    }))

  it.effect("turns an unreadable journal into a typed terminal failure", () =>
    Effect.gen(function*() {
      const runs = claimable(baseRow({ status: "suspended", owner: null, heartbeatAtMs: null }))

      const { outcomes } = yield* runRecovery(runs, {
        audit: auditRow(
          {
            version: 1,
            phase: "compensated",
            originalStatus: "suspended",
            suffixCount: 2,
            warnings: [],
            cancelledChildren: []
          } satisfies AuditDetail
        ),
        journal: Journal.makeNoop()
      })

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: "could not inspect archive commit for audit" }
      })
    }))

  it.effect("refuses an audit whose persisted protocol detail is unrecognisable", () =>
    Effect.gen(function*() {
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(baseRow({ status: "suspended" }))
      })

      const { audits, outcomes } = yield* runRecovery(runs, {
        audit: auditRow({ version: 2, phase: "archive_committed" })
      })

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: "audit audit has no recoverable protocol detail" }
      })
      expect(audits[0]).toMatchObject({
        status: "failed",
        detail: { phase: "terminal_failure", version: 1 }
      })
    }))

  it.effect("rejects every malformed recovery-detail shape independently", () =>
    Effect.gen(function*() {
      for (
        const detail of [
          null,
          [],
          { version: 1 },
          { version: 1, phase: 1, originalStatus: "suspended", suffixCount: 1, warnings: [], cancelledChildren: [] },
          {
            version: 1,
            phase: "compensated",
            originalStatus: "running",
            suffixCount: 1,
            warnings: [],
            cancelledChildren: []
          },
          {
            version: 1,
            phase: "compensated",
            originalStatus: "pending",
            suffixCount: "1",
            warnings: [],
            cancelledChildren: []
          },
          {
            version: 1,
            phase: "compensated",
            originalStatus: "pending",
            suffixCount: 1,
            warnings: {},
            cancelledChildren: []
          },
          {
            version: 1,
            phase: "compensated",
            originalStatus: "pending",
            suffixCount: 1,
            warnings: [],
            cancelledChildren: {}
          }
        ]
      ) {
        const { outcomes } = yield* runRecovery(
          RunStore.makeNoop({ get: () => Effect.succeed(baseRow({ status: "suspended" })) }),
          { audit: auditRow(detail) }
        )
        expect(outcomes[0]).toMatchObject({
          _tag: "Failed",
          error: { code: "unknown", message: "audit audit has no recoverable protocol detail" }
        })
      }
    }))

  it.effect("normalizes a non-Error recovery defect", () =>
    Effect.gen(function*() {
      const { outcomes } = yield* runRecovery(
        RunStore.makeNoop({ get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })) }),
        { livenessEvidence: () => Effect.die("recovery-defect") }
      )

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: "recovery-defect" }
      })
    }))

  it.effect("normalizes an Error recovery defect using its message", () =>
    Effect.gen(function*() {
      const { outcomes } = yield* runRecovery(
        RunStore.makeNoop({ get: () => Effect.succeed(baseRow({ status: "running", owner: stranger })) }),
        { livenessEvidence: () => Effect.die(new Error("recovery-error")) }
      )

      expect(outcomes[0]).toMatchObject({
        _tag: "Failed",
        error: { code: "unknown", message: "recovery-error" }
      })
    }))
})
