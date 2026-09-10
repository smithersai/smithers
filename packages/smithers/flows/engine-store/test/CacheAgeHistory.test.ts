import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as History from "../src/internal/CacheAgeHistory.ts"
import * as Verdicts from "../src/internal/CacheAgeVerdicts.ts"

const payload = {
  keyDigest: "key",
  action: "ttl",
  ttlMs: 1000,
  verdict: "admitted",
  recordedRunId: "producer",
  recordedEventSeq: 7
}
const meta = { lineageId: "smithers-journal-lineage/v1:[\"parent\"]" }
const sourceId = JournalEvent.SourceId.make("cache:key:ttl:producer:7")
const makeEntry = (runId: string, overrides: Partial<JournalEvent.Entry> = {}): JournalEvent.Entry =>
  new JournalEvent.Entry({
    runId: JournalEvent.RunId.make(runId),
    seq: JournalEvent.Seq.make(0),
    eventId: `${runId}:record`,
    sourceId,
    sourceSeq: JournalEvent.SourceSeq.make(0),
    emittedAtMs: 100,
    eventType: "flows.engine.cache-provenance",
    payload,
    meta,
    ...overrides
  })
const marker = (child = "child", parent = "parent"): JournalEvent.Entry =>
  makeEntry(child, {
    seq: JournalEvent.Seq.make(1),
    sourceSeq: JournalEvent.SourceSeq.make(1),
    sourceId: JournalEvent.SourceId.make("flows/time-travel/fork"),
    eventType: "flows.time-travel.fork-created",
    payload: { childRunId: child, parentRunId: parent, forkJournalOffset: 0 }
  })
const decision = new JournalEvent.Input({
  runId: JournalEvent.RunId.make("child"),
  sourceId,
  sourceSeq: JournalEvent.SourceSeq.make(0),
  eventType: "flows.engine.cache-provenance",
  payload: { ...payload, verdict: "expired" },
  meta: { lineageId: "smithers-journal-lineage/v1:[\"child\"]" }
})
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
const originalCause = new Error("original journal producer conflict")
const conflict = new Journal.JournalError({
  code: "idempotency_conflict",
  message: "incompatible recorded cache-age decision",
  cause: originalCause
})

type Fixture = {
  child: Array<JournalEvent.Entry>
  parent: Array<JournalEvent.Entry>
  parents: Record<string, string | null>
}
const fixture = (): Fixture => ({
  child: [makeEntry("child"), marker()],
  parent: [makeEntry("parent")],
  parents: { child: "parent", parent: null }
})
const services = (state: Fixture) => ({
  journal: Journal.makeNoop({
    entries: ({ runId, after, limit }) =>
      Effect.sync(() => {
        const rows = (runId === "child" ? state.child : state.parent).filter((entry) =>
          after === undefined || entry.seq > after
        )
        return { entries: rows.slice(0, limit), hasMore: rows.length > limit }
      })
  }),
  runs: RunStore.makeNoop({ get: (runId) => Effect.succeed(run(runId, state.parents[runId] ?? null)) })
})

describe("incremental verdict lookup", () => {
  it.effect("indexes producer and payload keys across pages and observes later verdicts", () =>
    Effect.gen(function*() {
      const state = fixture()
      state.child = Array.from({ length: 129 }, (_, seq) =>
        makeEntry("child", {
          seq: JournalEvent.Seq.make(seq),
          sourceId: JournalEvent.SourceId.make(`ordinary:${seq}`),
          payload: null
        }))
      const recorded = makeEntry("child", {
        seq: JournalEvent.Seq.make(129),
        // Both identities must survive even when the event is malformed.
        eventType: "unexpected",
        payload: { ...payload, keyDigest: "payload-key" }
      })
      state.child.push(recorded)
      const base = services(state).journal
      const cursors: Array<number | undefined> = []
      const journal = Journal.makeNoop({
        entries: (options) => {
          cursors.push(options.after)
          return base.entries(options)
        }
      })
      const lookup = Verdicts.make("child")
      expect(yield* lookup(journal, "missing")).toBeUndefined()
      expect(yield* lookup(journal, "key")).toEqual(recorded)
      expect(yield* lookup(journal, "payload-key")).toEqual(recorded)
      const later = makeEntry("child", {
        seq: JournalEvent.Seq.make(130),
        sourceId: JournalEvent.SourceId.make("altered-producer"),
        payload: { ...payload, keyDigest: "missing" }
      })
      state.child.push(later, makeEntry("child", { seq: JournalEvent.Seq.make(131) }))
      expect(yield* lookup(journal, "missing")).toEqual(later)
      expect(yield* lookup(journal, "key")).toEqual(recorded)
      expect(cursors).toEqual([undefined, 127, 129, 129, 129, 131])
      const malformed = makeEntry("child", {
        seq: JournalEvent.Seq.make(132),
        sourceId: JournalEvent.SourceId.make("cache:malformed:ttl:producer:7"),
        payload: { action: "ttl", keyDigest: 1 }
      })
      state.child.push(malformed)
      expect(yield* lookup(journal, "malformed")).toEqual(malformed)
    }))

  it.effect("rebuilds when the journal service or rewind generation changes", () =>
    Effect.gen(function*() {
      const state = fixture()
      const base = services(state).journal
      let generation = 0
      const journal = Journal.makeNoop({
        ...base,
        generation: () => Effect.succeed({ generation, afterSeq: -1 })
      })
      const lookup = Verdicts.make("child")
      expect(yield* lookup(journal, "key")).toEqual(state.child[0])
      state.child = []
      generation++
      expect(yield* lookup(journal, "key")).toBeUndefined()
      state.child = [makeEntry("child")]
      generation++
      expect(yield* lookup(journal, "key")).toEqual(state.child[0])
      const other = Journal.makeNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) })
      expect(yield* lookup(other, "key")).toBeUndefined()
      expect(yield* lookup(journal, "key")).toEqual(state.child[0])
    }))

  it.effect("preserves read failures and retries from the last fully processed page", () =>
    Effect.gen(function*() {
      const state = fixture()
      state.child = Array.from({ length: 129 }, (_, seq) =>
        makeEntry("child", {
          seq: JournalEvent.Seq.make(seq),
          sourceId: JournalEvent.SourceId.make(`ordinary:${seq}`),
          payload: {}
        }))
      state.child[128] = makeEntry("child", { seq: JournalEvent.Seq.make(128) })
      const base = services(state).journal
      const failure = new Journal.JournalError({ code: "read_failed", message: "injected suffix read failure" })
      let fail = true
      const cursors: Array<number | undefined> = []
      const journal = Journal.makeNoop({
        entries: (options) => {
          cursors.push(options.after)
          return fail && options.after !== undefined ? Effect.fail(failure) : base.entries(options)
        }
      })
      const lookup = Verdicts.make("child")
      expect(yield* lookup(journal, "key").pipe(Effect.result)).toEqual(Result.fail(failure))
      fail = false
      expect(yield* lookup(journal, "key")).toEqual(state.child[128])
      expect(cursors).toEqual([undefined, 127, 127])
    }))

  for (const empty of [false, true]) {
    it.effect(`refuses a nonadvancing projection cursor (${empty})`, () =>
      Effect.gen(function*() {
        const journal = Journal.makeNoop({
          entries: () => Effect.succeed({ entries: empty ? [] : [makeEntry("child")], hasMore: true })
        })
        const lookup = Verdicts.make("child")
        const result = yield* lookup(journal, "key").pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.code).toBe("read_failed")
      }))
  }
})

describe("validated history identity", () => {
  const mutations: ReadonlyArray<readonly [string, (state: Fixture) => void]> = [
    ["missing decision", (s) => {
      s.child.shift()
    }],
    ["producer source", (s) => {
      s.child[0] = makeEntry("child", { sourceId: JournalEvent.SourceId.make("other") })
    }],
    ["producer sequence", (s) => {
      s.child[0] = makeEntry("child", { sourceSeq: JournalEvent.SourceSeq.make(2) })
    }],
    ["event type", (s) => {
      s.child[0] = makeEntry("child", { eventType: "other" })
    }],
    ...[
      ["key", { ...payload, keyDigest: "other" }],
      ["TTL", { ...payload, ttlMs: 999 }],
      ["recorded run", { ...payload, recordedRunId: "other" }],
      ["recorded event", { ...payload, recordedEventSeq: 8 }],
      ["action", { ...payload, action: "expired" }],
      ["verdict", { ...payload, verdict: "unknown" }],
      ["null payload", null],
      ["array payload", []],
      ["extra payload", { ...payload, extra: true }]
    ].map(([name, changed]) =>
      [name as string, (s: Fixture) => {
        s.child[0] = makeEntry("child", { payload: changed })
      }] as const
    ),
    ...[null, [], {}, { lineageId: "foreign" }, { ...meta, extra: true }].map((changed, i) =>
      [`lineage ${i}`, (s: Fixture) => {
        s.child[0] = makeEntry("child", { meta: changed })
      }] as const
    ),
    ["no ancestry", (s) => {
      s.parents.child = null
    }],
    ["no fork marker", (s) => {
      s.child.pop()
    }],
    ["marker producer", (s) => {
      s.child[1] = { ...marker(), sourceId: JournalEvent.SourceId.make("forged") }
    }],
    ["marker producer sequence", (s) => {
      s.child[1] = { ...marker(), sourceSeq: JournalEvent.SourceSeq.make(0) }
    }],
    ["marker child", (s) => {
      s.child[1] = marker("other", "parent")
    }],
    ["marker parent", (s) => {
      s.child[1] = marker("child", "other")
    }],
    ["marker metadata", (s) => {
      s.child[1] = { ...marker(), meta: { lineageId: "foreign" } }
    }],
    ["marker cutoff below decision", (s) => {
      s.child[1] = { ...marker(), payload: { childRunId: "child", parentRunId: "parent", forkJournalOffset: -1 } }
    }],
    ["marker cutoff not adjacent", (s) => {
      s.child[1] = { ...marker(), seq: JournalEvent.Seq.make(3), sourceSeq: JournalEvent.SourceSeq.make(3) }
    }],
    ["marker cutoff fractional", (s) => {
      s.child[1] = { ...marker(), payload: { childRunId: "child", parentRunId: "parent", forkJournalOffset: 0.5 } }
    }],
    ["missing parent cutoff", (s) => {
      s.parent = []
    }],
    ["parent producer missing", (s) => {
      s.parent[0] = makeEntry("parent", { sourceId: JournalEvent.SourceId.make("other") })
    }],
    ["parent timestamp", (s) => {
      s.parent[0] = makeEntry("parent", { emittedAtMs: 101 })
    }],
    ["parent type", (s) => {
      s.parent[0] = makeEntry("parent", { eventType: "other" })
    }],
    ["parent payload", (s) => {
      s.parent[0] = makeEntry("parent", { payload: { ...payload, ttlMs: 1001 } })
    }],
    ["parent metadata", (s) => {
      s.parent[0] = makeEntry("parent", { meta: null })
    }],
    ["marker null payload", (s) => {
      s.child[1] = { ...marker(), payload: null }
    }],
    ["marker missing cutoff", (s) => {
      s.child[1] = { ...marker(), payload: { childRunId: "child", parentRunId: "parent" } }
    }],
    ["marker extra field", (s) => {
      s.child[1] = {
        ...marker(),
        payload: { childRunId: "child", parentRunId: "parent", forkJournalOffset: 0, extra: true }
      }
    }],
    ["primitive copied metadata", (s) => {
      s.child[0] = makeEntry("child", { meta: "foreign" })
    }],
    ["parent sequence", (s) => {
      s.parent = [makeEntry("parent", { seq: JournalEvent.Seq.make(1) })]
      s.child[1] = {
        ...marker(),
        seq: JournalEvent.Seq.make(2),
        sourceSeq: JournalEvent.SourceSeq.make(2),
        payload: { childRunId: "child", parentRunId: "parent", forkJournalOffset: 1 }
      }
    }],
    ...[null, [], "foreign"].map((changed, i) =>
      [`malformed original metadata ${i}`, (s: Fixture) => {
        s.parent = [
          makeEntry("parent", { meta: changed }),
          makeEntry("parent", { seq: JournalEvent.Seq.make(1), sourceId: JournalEvent.SourceId.make("cutoff") })
        ]
        s.child[1] = {
          ...marker(),
          seq: JournalEvent.Seq.make(2),
          sourceSeq: JournalEvent.SourceSeq.make(2),
          payload: { childRunId: "child", parentRunId: "parent", forkJournalOffset: 1 }
        }
      }] as const
    ),
    ["foreign lineage without ancestor proof", (s) => {
      s.child[0] = makeEntry("child", { meta: { lineageId: "foreign" } })
      s.child[1] = { ...marker(), meta: { lineageId: "foreign" } }
      s.parent[0] = makeEntry("parent", { meta: { lineageId: "foreign" } })
    }]
  ]
  for (const [name, mutate] of mutations) {
    it.effect(`refuses ${name} with the original conflict`, () =>
      Effect.gen(function*() {
        const state = fixture()
        mutate(state)
        const result = yield* History.copiedVerdict({ ...services(state), runId: "child", decision, conflict }).pipe(
          Effect.result
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBe(conflict)
          expect(result.failure.cause).toBe(originalCause)
        }
      }))
  }

  it.effect("preserves an expired verdict on a younger clock", () =>
    Effect.gen(function*() {
      const state = fixture()
      state.child[0] = makeEntry("child", { payload: { ...payload, verdict: "expired" } })
      state.parent[0] = makeEntry("parent", { payload: { ...payload, verdict: "expired" } })
      expect(
        yield* History.copiedVerdict({
          ...services(state),
          runId: "child",
          decision: { ...decision, payload },
          conflict
        })
      ).toBe("expired")
    }))

  it.effect("preserves a run-store failure as the typed conflict's cause", () =>
    Effect.gen(function*() {
      const state = fixture()
      const cause = new RunStore.RunStoreError({
        code: "persistence_failed",
        method: "get",
        message: "injected read failure",
        cause: originalCause
      })
      const result = yield* History.copiedVerdict({
        ...services(state),
        runs: RunStore.makeNoop({ get: () => Effect.fail(cause) }),
        runId: "child",
        decision,
        conflict
      }).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toMatchObject({ code: "idempotency_conflict", cause })
    }))

  for (const cyclic of [false, true]) {
    it.effect(cyclic ? "refuses cyclic ancestry" : "validates a fork of a fork", () =>
      Effect.gen(function*() {
        const lineage = { lineageId: "smithers-journal-lineage/v1:[\"grandparent\"]" }
        const rows: Record<string, Array<JournalEvent.Entry>> = {
          child: [makeEntry("child", { meta: lineage }), { ...marker(), meta: lineage }],
          parent: [makeEntry("parent", { meta: lineage }), {
            ...marker("parent", cyclic ? "child" : "grandparent"),
            meta: lineage
          }],
          grandparent: [makeEntry("grandparent", { meta: lineage })]
        }
        const journal = Journal.makeNoop({
          entries: ({ runId }) => Effect.succeed({ entries: rows[runId]!, hasMore: false })
        })
        const runs = RunStore.makeNoop({
          get: (runId) => Effect.succeed(run(runId, runId === "child" ? "parent" : cyclic ? "child" : "grandparent"))
        })
        const result = yield* History.copiedVerdict({ journal, runs, runId: "child", decision, conflict }).pipe(
          Effect.result
        )
        if (cyclic) {
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) expect(result.failure).toBe(conflict)
        } else expect(result).toEqual(Result.succeed("admitted"))
      }))
  }

  for (const count of [127, 128, 129]) {
    it.effect(`finds history across the 128-row page boundary at ${count}`, () =>
      Effect.gen(function*() {
        const entries = Array.from({ length: count }, (_, i) =>
          makeEntry("child", { seq: JournalEvent.Seq.make(i), sourceSeq: JournalEvent.SourceSeq.make(i) }))
        const calls: Array<number | undefined> = []
        const journal = Journal.makeNoop({
          entries: ({ after, limit }) => {
            calls.push(after)
            const rows = entries.filter((entry) =>
              after === undefined || entry.seq > after
            )
            return Effect.succeed({ entries: rows.slice(0, limit), hasMore: rows.length > limit })
          }
        })
        expect(
          yield* History.find(journal, "child", (entry) => entry.seq === count - 1)
        ).toEqual(entries[count - 1])
        expect(calls).toEqual(count <= 128 ? [undefined] : [undefined, 127])
      }))
  }

  for (const empty of [false, true]) {
    it.effect(`refuses a nonadvancing history cursor (${empty})`, () =>
      Effect.gen(function*() {
        const journal = Journal.makeNoop({
          entries: () => Effect.succeed({ entries: empty ? [] : [makeEntry("child")], hasMore: true })
        })
        const result = yield* History.find(journal, "child", () => false).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.code).toBe("read_failed")
      }))
  }
})
