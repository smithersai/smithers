/**
 * The history cap at the seams the public service cannot reach on its own:
 * the resolver, the owned suffix read a rewind performs after validation, and
 * the fork's fault-injection hooks.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Fork from "../src/internal/Fork.ts"
import * as HistoryLimit from "../src/internal/HistoryLimit.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const owner: OwnerId = { hostId: "test-host", pid: 10, nonce: "cap-owner" }
const lineageId = "run/root"

const entry = (seq: number): JournalEvent.Entry => ({
  runId: "run" as JournalEvent.RunId,
  seq: seq as JournalEvent.Seq,
  eventId: `event-${seq}`,
  sourceId: "cap" as JournalEvent.SourceId,
  sourceSeq: seq as JournalEvent.SourceSeq,
  emittedAtMs: seq,
  eventType: "test",
  payload: {},
  meta: { lineageId }
})

const journalOf = (entries: ReadonlyArray<JournalEvent.Entry>) =>
  Journal.makeNoop({
    entries: ({ after, limit }) =>
      Effect.sync(() => {
        const remaining = entries.filter((item) => item.seq > (after ?? -1))
        const page = remaining.slice(0, limit)
        return { entries: page, hasMore: remaining.length > page.length }
      })
  })

const row: RunStore.RunRow = {
  runId: "run",
  status: "suspended",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}"
}

describe("HistoryLimit.resolve", () => {
  it.effect("falls back when the caller names no cap and keeps a positive integer", () =>
    Effect.gen(function*() {
      expect(yield* HistoryLimit.resolve(undefined, 7)).toBe(7)
      expect(yield* HistoryLimit.resolve(3, 7)).toBe(3)
      expect(HistoryLimit.defaultMaxHistoryEntries).toBe(100_000)
    }))

  it.effect("refuses anything that is not a positive safe integer", () =>
    Effect.gen(function*() {
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        expect(yield* Effect.flip(HistoryLimit.resolve(value, 7))).toMatchObject({
          code: "invalid",
          message: `maxHistoryEntries must be a positive integer, not ${String(value)}`
        })
      }
      expect(HistoryLimit.exceeded("replay", "run", 4)).toMatchObject({
        code: "limit_exceeded",
        message: "replay of run would read more than 4 journal entries; raise maxHistoryEntries to allow it"
      })
    }))
})

describe("Rewind.rewind under the cap", () => {
  it.effect("refuses an over-long suffix read under the claim and rolls the audit back", () =>
    Effect.gen(function*() {
      // `validate` refuses this before the claim on the public path; calling
      // the owned protocol directly is what reaches the second check.
      const store = MemoryTimeTravelStore.make({
        records: [0, 1, 2].map((seq) => ({ runId: "run", seq, eventId: `event-${seq}`, lineageId, payload: {} }))
      })
      const transitions: Array<RunStore.RunStatus> = []
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(row),
        claim: (_runId, _expected, _owner, nowMs) => Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: nowMs }),
        activate: () => Effect.succeed({ _tag: "Activated" as const }),
        transitionOwned: (_runId, _owner, status) =>
          Effect.sync(() => {
            transitions.push(status)
            return { _tag: "Transitioned" as const }
          })
      })

      const failure = yield* Effect.flip(
        Rewind.rewind({ runId: "run", frame: { lineageId, seq: 0 }, owner, maxEntries: 1 }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(TimeTravelStore)(store),
              Layer.succeed(RunStore.RunStore)(runs),
              Layer.succeed(Journal.Journal)(journalOf([entry(0), entry(1), entry(2)])),
              Layer.succeed(Jj.Jj)(
                Jj.makeNoop({ snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }) })
              ),
              CacheStore.layerNoop(),
              EffectHandlerRegistry.layerNoop
            )
          )
        )
      )

      expect(failure).toMatchObject({ code: "limit_exceeded" })
      expect(store.state().records.map((record) => record.seq)).toEqual([0, 1, 2])
      expect(store.state().audits.map((audit) => audit.status)).toEqual(["failed"])
      expect(store.state().audits[0]?.detail).toMatchObject({ phase: "rolled_back" })
      expect(transitions).toEqual(["suspended"])
    }))
})

describe("Fork.fork hooks", () => {
  const frame = { lineageId, seq: 0 } as const

  const fork = (
    jj: Partial<Jj.Jj>,
    beforeStep: (step: Fork.ForkStep) => Effect.Effect<void, unknown>
  ) => {
    const store = MemoryTimeTravelStore.make({
      records: [{ runId: "run", seq: 0, eventId: "event-0", lineageId, payload: {} }]
    })
    return Effect.scoped(
      Fork.fork({ parentRunId: "run", frame, workspaceRoot: "/tmp/lanes", hooks: { beforeStep } }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(TimeTravelStore)(store),
            Layer.succeed(RunStore.RunStore)(RunStore.makeNoop({ get: () => Effect.succeed(row) })),
            Layer.succeed(Journal.Journal)(journalOf([])),
            Layer.succeed(Jj.Jj)(Jj.makeNoop(jj)),
            CacheStore.layerNoop(),
            EffectHandlerRegistry.layerNoop
          )
        ),
        Effect.exit,
        Effect.map((exit) => ({ exit, intents: store.state().forkIntents, edges: store.state().edges }))
      )
    )
  }

  it.effect("runs before provisioning and before the commit, and a refusal at either step adds no fork", () =>
    Effect.gen(function*() {
      const steps: Array<Fork.ForkStep> = []
      const calls: Array<string> = []
      const jj: Partial<Jj.Jj> = {
        workspaceAdd: (name) => Effect.sync(() => void calls.push(`add:${name}`)),
        workspaceForget: (name) => Effect.sync(() => void calls.push(`forget:${name}`))
      }

      const provisioning = yield* fork(jj, (step) => {
        steps.push(step)
        return step === "provision-workspace" ? Effect.fail("stop") : Effect.void
      })
      expect(provisioning.exit).toMatchObject({ _tag: "Failure" })
      expect(calls).toEqual([])
      // The reservation stands: it is what keeps the next mint off this name.
      expect(provisioning.intents).toHaveLength(1)
      expect(provisioning.edges).toEqual([])

      const committing = yield* fork(jj, (step) => step === "commit-fork" ? Effect.fail("stop") : Effect.void)
      const lane = Fork.workspaceNameFor(committing.intents[0]!.childRunId)
      expect(committing.exit).toMatchObject({ _tag: "Failure" })
      expect(calls).toEqual([`add:${lane}`, `forget:${lane}`])
      expect(committing.edges).toEqual([])
      expect(steps).toEqual(["provision-workspace"])
    }))

  it.effect("reports a lane it could not forget after a refused commit, keeping the commit's own failure", () =>
    Effect.gen(function*() {
      const logged: Array<string> = []

      const result = yield* fork(
        { workspaceAdd: () => Effect.void },
        (step) => step === "commit-fork" ? Effect.fail("stop") : Effect.void
      ).pipe(
        Effect.provide(Logger.layer([Logger.make<unknown, void>(({ message }) => logged.push(String(message)))]))
      )

      expect(Exit.isFailure(result.exit)).toBe(true)
      if (Exit.isFailure(result.exit)) {
        expect(Cause.squash(result.exit.cause)).toMatchObject({
          code: "unknown",
          message: "fork failed at commit-fork"
        })
      }
      expect(logged).toContain("time-travel: could not forget fork workspace after a refused commit")
    }))
})
