/**
 * The replay convergence emit (`emitConverging`, issue #109) may tolerate an
 * `idempotency_conflict` only after reading the occupying record and proving
 * it is the record being emitted as a validated fork ancestor recorded it.
 * Anything else in the producer slot surfaces the journal's own conflict
 * (review finding flows-engine-store-b/robustness/1).
 *
 * Every dependency is an inert memory double so each case controls the exact
 * rows the journal answers with, including the fork marker and the parent's
 * original row a real time-travel fork copies verbatim.
 */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner = { hostId: "conflict-host", pid: 1, nonce: "conflict-process" }
const child = "conflict-child"
const parent = "conflict-parent"
const key = "replay-conflict/terminal"
const attemptId = { runId: child, stepKeyDigest: sha256(key), attempt: 1 }
const sourceId = `conflict:attempt:${attemptId.stepKeyDigest}:1:finished`

type Row = Record<string, unknown>

/**
 * The rows a fork of `parent` at its first record leaves behind: the parent's
 * original terminal record, the child's verbatim copy at the same `seq`, and
 * the fork marker directly above the copied prefix. `mutate` bends the copied
 * pair (in both runs, so the copy still matches its original) into the shape
 * under test; `ancestry` bends the marker and the parent edge.
 */
const forkFixture = (
  attempted: JournalEvent.Input,
  options: {
    readonly mutate?: (copied: Row) => Row
    readonly ancestry?: "complete" | "no-marker" | "no-parent"
  } = {}
) => {
  const payload = attempted.payload as Row
  const meta = attempted.meta as Row
  const copied: Row = (options.mutate ?? ((row) => row))({
    runId: child,
    seq: 0,
    eventId: "fork:child:0",
    sourceId,
    sourceSeq: 0,
    emittedAtMs: 100,
    eventType: attempted.eventType,
    payload: { ...payload, runId: parent },
    meta: { ...meta, lineageId: FlowEngine.Lineage.root(parent) }
  })
  const marker: Row = {
    runId: child,
    seq: 1,
    eventId: "fork:child:created",
    sourceId: "flows/time-travel/fork",
    sourceSeq: 1,
    emittedAtMs: 101,
    eventType: "flows.time-travel.fork-created",
    payload: { childRunId: child, parentRunId: parent, forkJournalOffset: 0 },
    // The marker carries the lineage of the frame the fork was cut at.
    meta: { lineageId: (copied["meta"] as Row)["lineageId"] }
  }
  const ancestry = options.ancestry ?? "complete"
  const rows: Record<string, ReadonlyArray<Row>> = {
    [child]: ancestry === "no-marker" ? [copied] : [copied, marker],
    [parent]: [{ ...copied, runId: parent, eventId: "parent:0" }]
  }
  return {
    rows,
    parentOf: (runId: string): string | null => runId === child && ancestry !== "no-parent" ? parent : null
  }
}

/** Neither the working copy nor the boundary is reached: the attempt is replayed, never executed. */
const untouched = Layer.mergeAll(
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: () => Effect.die("must not snapshot"),
      restore: () => Effect.die("must not restore"),
      diff: () => Effect.die("must not diff"),
      workspaceAdd: () => Effect.die("must not add a workspace"),
      workspaceForget: () => Effect.die("must not forget a workspace"),
      status: () => Effect.die("must not read status")
    })
  ),
  StepBoundary.layerTest()
)

const run = (runId: string, parentRunId: string | null): RunStore.RunRow => ({
  runId,
  parentRunId,
  status: "running",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  claim: null,
  claimedAtMs: null,
  cancelRequestedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  stateJson: "{}"
})

/**
 * Replays a durably succeeded attempt whose terminal record the journal
 * refuses with `idempotency_conflict`, answering history from `fixture`.
 */
const replay = (
  fixture: (attempted: JournalEvent.Input) => ReturnType<typeof forkFixture>,
  journalOverrides: Partial<Journal.Service> = {}
) =>
  Effect.gen(function*() {
    let executions = 0
    let reads = 0
    let history: ReturnType<typeof forkFixture> | undefined
    const conflict = new Journal.JournalError({
      code: "idempotency_conflict",
      message: `source event ${sourceId}:0 for run ${child} was reused with different content`
    })
    const attempts = AttemptStore.makeNoop({
      get: () =>
        Effect.succeedSome({
          ...attemptId,
          state: "succeeded",
          startedAtMs: 0,
          finishedAtMs: 1,
          outcome: "durable-success",
          meta: { tier: "sealed" }
        })
    })
    const journal = Journal.makeNoop({
      emitDurable: (record) =>
        Effect.suspend(() => {
          if (record.sourceId !== sourceId || record.eventType !== "flows.engine.attempt-finished") {
            return Effect.die(new Error(`unexpected emit ${record.eventType}`))
          }
          history = fixture(record)
          return Effect.fail(conflict)
        }),
      entries: ({ runId }) =>
        Effect.sync(() => {
          reads++
          return { entries: (history?.rows[runId] ?? []) as never, hasMore: false }
        }),
      ...journalOverrides
    })
    const runs = RunStore.makeNoop({
      heartbeat: () => Effect.succeed({ _tag: "Updated" }),
      get: (runId) => Effect.succeed(run(runId, history?.parentOf(runId) ?? null))
    })
    const exit = yield* withCrypto(
      ActionPersistence.make({
        runId: child,
        owner,
        sourceId: "conflict",
        execute: () => Effect.sync(() => (++executions, "re-executed"))
      })({ action: {}, key, attempt: 1, tier: "sealed" }).pipe(
        Effect.provide(Layer.mergeAll(
          Layer.succeed(AttemptStore.AttemptStore, attempts),
          Layer.succeed(Journal.Journal, journal),
          CacheStore.layerNoop({ get: () => Effect.succeedNone }),
          Layer.succeed(RunStore.RunStore, runs),
          untouched
        )),
        Effect.exit,
        Effect.scoped
      )
    )
    return { exit, executions, reads: () => reads, conflict }
  })

const failedWith = (exit: Exit.Exit<unknown, unknown>) => {
  expect(exit._tag).toBe("Failure")
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons[0]
  expect(reason?._tag).toBe("Fail")
  return (reason as { readonly error?: unknown }).error
}

describe("replay validates the record occupying the terminal producer slot", () => {
  it.effect("replays through a terminal record a retained fork copied from its parent", () =>
    Effect.gen(function*() {
      const outcome = yield* replay((attempted) => forkFixture(attempted))
      expect(outcome.exit).toEqual(Exit.succeed("durable-success"))
      expect(outcome.executions).toBe(0)
      expect(outcome.reads()).toBeGreaterThan(0)
    }))

  it.effect("replays through a fork of a fork", () =>
    Effect.gen(function*() {
      const grandparent = "conflict-grandparent"
      const outcome = yield* replay((attempted) => {
        const base = forkFixture(attempted, {
          mutate: (row) => ({
            ...row,
            payload: { ...(row["payload"] as Row), runId: grandparent },
            meta: { ...(row["meta"] as Row), lineageId: FlowEngine.Lineage.root(grandparent) }
          })
        })
        const marker = { ...base.rows[child]![1]! }
        return {
          rows: {
            ...base.rows,
            [parent]: [
              base.rows[parent]![0]!,
              {
                ...marker,
                runId: parent,
                meta: { lineageId: FlowEngine.Lineage.root(grandparent) },
                payload: { childRunId: parent, parentRunId: grandparent, forkJournalOffset: 0 }
              }
            ],
            [grandparent]: [{ ...base.rows[parent]![0]!, runId: grandparent }]
          },
          parentOf: (runId: string): string | null => runId === child ? parent : runId === parent ? grandparent : null
        }
      })
      expect(outcome.exit).toEqual(Exit.succeed("durable-success"))
      expect(outcome.executions).toBe(0)
    }))

  const rejected: ReadonlyArray<[string, Parameters<typeof forkFixture>[1]]> = [
    ["an unrelated event type", { mutate: (row) => ({ ...row, eventType: "unrelated.event", payload: { x: 1 } }) }],
    ["another attempt's coordinates", {
      mutate: (row) => ({ ...row, payload: { ...(row["payload"] as Row), attempt: 2 } })
    }],
    ["another step's coordinates", {
      mutate: (row) => ({ ...row, payload: { ...(row["payload"] as Row), stepKeyDigest: sha256("other") } })
    }],
    ["the opposite terminal state", {
      mutate: (row) => ({ ...row, payload: { ...(row["payload"] as Row), state: "failed" } })
    }],
    ["a record no fork copied (foreign payload, no marker)", { ancestry: "no-marker" }],
    ["a record whose run has no parent", { ancestry: "no-parent" }],
    ["a copy whose lineage names a run outside the ancestry", {
      mutate: (row) => ({ ...row, meta: { ...(row["meta"] as Row), lineageId: FlowEngine.Lineage.root("stranger") } })
    }]
  ]
  for (const [shape, options] of rejected) {
    it.effect(`surfaces the journal's conflict for ${shape}`, () =>
      Effect.gen(function*() {
        const outcome = yield* replay((attempted) => forkFixture(attempted, options))
        expect(failedWith(outcome.exit)).toBe(outcome.conflict)
        expect(outcome.executions).toBe(0)
      }))
  }

  it.effect("surfaces a history read failure instead of guessing", () =>
    Effect.gen(function*() {
      const outcome = yield* replay((attempted) => forkFixture(attempted), {
        entries: () => Effect.fail(new Journal.JournalError({ code: "read_failed", message: "history unavailable" }))
      })
      expect(failedWith(outcome.exit)).toMatchObject({ code: "read_failed" })
      expect(outcome.executions).toBe(0)
    }))
})
