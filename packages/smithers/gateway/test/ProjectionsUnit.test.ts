/**
 * The read path's own behaviour: what it does when the control plane refuses,
 * answers something else, or keeps producing events.
 *
 * The suites beside this one run the read path against a real SQLite control
 * plane and prove the rows. These drive a stub control service instead,
 * because the branches under test are the gateway's: a listing that fails, a
 * response of the wrong shape, a subscription that must keep following, and a
 * real control plane cannot be asked to produce them on demand.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Service as ControlService } from "@smthrs/control/Control"
import { PersistenceError, Unavailable } from "@smthrs/control/ControlError"
import type { ControlEvent, ListResponse, RunSummary } from "@smthrs/control/ControlSchema"
import { Deferred, Effect, Logger, Schema, Stream } from "effect"
import { GatewayError } from "../src/GatewayError.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import * as Projections from "../src/Projections.ts"

const die = () => Effect.die("the suite does not use this operation")

const run: RunSummary = {
  runId: "run-1",
  flowId: "deploy",
  status: "waiting-approval",
  createdAt: 1,
  updatedAt: 2
}

const numberedRun = (ordinal: number): RunSummary => ({
  ...run,
  runId: `run-${ordinal}`
})

const event = (sequence: number, kind: string, payload: unknown): ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: payload as ControlEvent["payload"]
})

const approvalRequested = event(1, "control.approval.requested", {
  runId: "run-1",
  requestId: "gate",
  question: "Ship?",
  payload: {
    target: {
      _tag: "Node",
      runId: "run-1",
      requestId: "gate",
      digest: "d",
      envelope: { capabilities: [], flows: [], budget: {} }
    },
    scope: "run",
    idempotencyKey: "k"
  }
})

/** A control service answering exactly what a test needs and nothing else. */
const control = (overrides: Partial<ControlService>): ControlService => ({
  plan: die,
  run: die,
  approve: die,
  deny: die,
  steer: die,
  signal: die,
  cancel: die,
  pause: die,
  resume: die,
  list: () => Effect.succeed({ _tag: "runs", items: [] } satisfies ListResponse),
  watch: () => Stream.empty,
  ...overrides
} as ControlService)

const make = (
  service: ControlService,
  options: { readonly heartbeatMillis?: number | undefined } = {}
): Projections.Service => Effect.runSync(Projections.make(service, options))

const issuedCursor = (
  selector: GatewaySchema.ProjectionSelector,
  value: number,
  offset = 0
): GatewaySchema.ProjectionCursor => ({
  selector,
  projection: selector._tag,
  runId: "runId" in selector ? selector.runId ?? null : null,
  value,
  offset
})

describe("Projections run-list pagination", () => {
  it.effect("folds workspace rows from every control-list page", () =>
    Effect.gen(function*() {
      const first = Array.from({ length: 100 }, (_, index) => numberedRun(index + 1))
      const second = [numberedRun(101)]
      let listCalls = 0
      const projections = make(control({
        list: (request) => {
          if (request._tag === "runs" && request.filters?.runId) {
            return Effect.succeed({
              _tag: "runs",
              items: [...first, ...second].filter((run) => run.runId === request.filters?.runId)
            })
          }
          listCalls += 1
          return Effect.succeed(
            listCalls === 1
              ? { _tag: "runs", items: first, nextCursor: "page-2" } satisfies ListResponse
              : { _tag: "runs", items: second } satisfies ListResponse
          )
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(snapshot.rows.map((row) => (row as { readonly runId: string }).runId)).toEqual(
        [...first, ...second].map((item) => item.runId)
      )
      expect(listCalls).toBe(2)
    }))

  it.effect("stops a perpetually paginated listing at the workspace ceiling", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const projections = make(control({
        list: (request) => {
          if (request._tag === "runs" && request.filters?.runId) {
            return Effect.succeed({
              _tag: "runs",
              items: [numberedRun(Number(request.filters.runId.slice(4)))]
            })
          }
          const page = listCalls
          listCalls += 1
          return Effect.succeed(
            {
              _tag: "runs",
              items: Array.from({ length: 100 }, (_, index) => numberedRun(page * 100 + index + 1)),
              nextCursor: `page-${page + 1}`
            } satisfies ListResponse
          )
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(Projections.maxWorkspaceRuns).toBe(500)
      expect(snapshot.rows).toHaveLength(500)
      expect(listCalls).toBe(5)
    }))

  it.effect("passes an explicit numeric limit on every run-list request", () =>
    Effect.gen(function*() {
      const limits: Array<number | undefined> = []
      const projections = make(control({
        list: (request) => {
          if (request._tag === "runs" && request.filters?.runId) return Effect.succeed({ _tag: "runs", items: [run] })
          limits.push(request.limit)
          return Effect.succeed(
            limits.length === 1
              ? { _tag: "runs", items: [run], nextCursor: "page-2" } satisfies ListResponse
              : { _tag: "runs", items: [] } satisfies ListResponse
          )
        }
      }))

      yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(limits).toEqual([Projections.maxWorkspaceRuns, Projections.maxWorkspaceRuns - 1])
    }))

  it.effect("does not page a run-scoped lookup past its first match", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const limits: Array<number | undefined> = []
      const projections = make(control({
        list: (request) => {
          listCalls += 1
          limits.push(request.limit)
          return Effect.succeed({ _tag: "runs", items: [run], nextCursor: "another-page" } satisfies ListResponse)
        }
      }))

      const snapshot = yield* projections.snapshot({ _tag: "run-summary", runId: run.runId })
      expect(snapshot.rows).toHaveLength(1)
      expect(listCalls).toBe(2)
      expect(limits).toEqual([1, 1])
    }))

  it.effect("maps and redacts a failure from a later run-list page", () =>
    Effect.gen(function*() {
      let listCalls = 0
      const persistence = new PersistenceError({
        operation: "list runs at /private/tmp/control.db",
        message: "SQL failed on the second page",
        cause: { statement: "select secret from runs" }
      })
      const projections = make(control({
        list: () => {
          listCalls += 1
          return listCalls === 1
            ? Effect.succeed({ _tag: "runs", items: [run], nextCursor: "page-2" } satisfies ListResponse)
            : Effect.fail(persistence)
        }
      }))

      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(listCalls).toBe(2)
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Listing runs failed")
      expect(failure.cause).toEqual({ _tag: "/control/PersistenceError", code: "persistence_failed" })
      expect(JSON.stringify(failure)).not.toContain("SQL failed")
      expect(JSON.stringify(failure)).not.toContain("select secret")
      expect(JSON.stringify(failure)).not.toContain("/private/tmp")
    }))
})

describe("Projections read-path failures", () => {
  it.effect("reports a failed run listing as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = make(
        control({ list: () => Effect.fail(new Unavailable({ code: "unavailable", feature: "list", ticket: "T-1" })) })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Listing runs failed")
      expect(failure.cause).toEqual({ _tag: "/control/Unavailable", code: "unavailable" })
    }))

  it.effect("redacts a persistence failure before it reaches a caller", () =>
    Effect.gen(function*() {
      const nested = new Error("nested driver detail at /private/tmp/control.db")
      nested.cause = nested
      const persistence = new PersistenceError({
        operation: "list runs",
        message: "SQL failed while reading /private/tmp/control.db",
        cause: { nested, statement: "select secret from runs", offset: 1n }
      })
      const projections = make(control({ list: () => Effect.fail(persistence) }))

      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.cause).toEqual({ _tag: "/control/PersistenceError", code: "persistence_failed" })
      const json = JSON.stringify(failure)
      for (const privateText of ["SQL failed", "nested driver", "/private/tmp", "select secret"]) {
        expect(json).not.toContain(privateText)
      }
      expect(() => Schema.encodeUnknownSync(GatewayError)(failure)).not.toThrow()
    }))

  it.effect("carries no cause at all when the failure is not a tagged error", () =>
    Effect.gen(function*() {
      // A control plane is typed, but the wire is not: a transport that hands
      // back a string, a bare object, or nothing is still a read that failed,
      // and the client learns that much and nothing it cannot act on.
      for (
        const opaque of [
          "boom",
          { message: "boom", statement: "select secret from runs" },
          { _tag: 7 },
          null
        ]
      ) {
        const projections = make(
          control({ list: () => Effect.fail(opaque as unknown as Unavailable) })
        )
        const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
        expect(failure.code).toBe("run_unavailable")
        expect(failure.cause).toBeUndefined()
        expect(JSON.stringify(failure)).not.toContain("select secret")
      }
    }))

  it.effect("names a tagged failure that carries no code", () =>
    Effect.gen(function*() {
      const projections = make(
        control({ list: () => Effect.fail({ _tag: "/control/Mystery" } as unknown as Unavailable) })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.cause).toEqual({ _tag: "/control/Mystery" })
    }))

  it.effect("reports a failed event read as a gateway refusal naming the run", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-2" }))
        })
      )
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-summary", runId: "run-1" }))
      expect(failure.message).toBe("Reading the events of run-1 failed")
    }))

  it.effect("treats a listing that answered about flows as no runs at all", () =>
    Effect.gen(function*() {
      const projections = make(
        control({ list: () => Effect.succeed({ _tag: "flows", items: [] } satisfies ListResponse) })
      )
      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(snapshot.rows).toEqual([])
    }))
})

describe("Projections resource bounds", () => {
  it.effect("stops reading at the first event past the per-run ceiling", () =>
    Effect.gen(function*() {
      let produced = 0
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () =>
          Stream.iterate(1, (sequence) => sequence + 1).pipe(
            Stream.take(Projections.maxEventsPerRun + 50),
            Stream.map((sequence) => {
              produced += 1
              return event(sequence, "control.test", null)
            })
          )
      }))

      const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-events", runId: run.runId }))
      expect(failure.code).toBe("resource_limit")
      expect(produced).toBe(Projections.maxEventsPerRun + 1)
    }))

  for (const offset of [-1, 0, 1]) {
    for (const prefix of ["", "café😀\\\"\n"]) {
      it.effect(`checks complete UTF-8 event and row encodings at N${offset >= 0 ? "+" : ""}${offset} (${JSON.stringify(prefix)})`, () =>
        Effect.gen(function*() {
          const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
          const target = Projections.maxProjectionBytes + offset
          // Include two members: array delimiters, comma, escaped characters and
          // multibyte text all contribute to the independently measured budget.
          const history = [event(1, "control.test", prefix), event(2, "control.test", "")]
          history[1] = event(2, "control.test", "x".repeat(target - bytes(history)))
          const rows = [{ ...run, waitingReason: prefix }, { ...run, runId: "run-2", waitingReason: "" }]
          const baseline = yield* make(
            control({
              list: (request) =>
                Effect.succeed({
                  _tag: "runs",
                  items: request._tag === "runs" && request.filters?.runId
                    ? rows.filter((run) => run.runId === request.filters?.runId)
                    : rows
                })
            })
          )
            .snapshot({ _tag: "workspace-runs" })
          const padding = "x".repeat(target - bytes(baseline.rows))
          rows[1] = { ...rows[1]!, waitingReason: padding }
          const expectedRows = [baseline.rows[0], { ...baseline.rows[1] as object, waitingReason: padding }]
          expect(bytes(history)).toBe(target)
          expect(bytes(expectedRows)).toBe(target)
          const eventsProjection = make(control({
            list: () => Effect.succeed({ _tag: "runs", items: [run] }),
            watch: () => Stream.fromIterable(history)
          }))
          const rowsProjection = make(
            control({
              list: (request) =>
                Effect.succeed({
                  _tag: "runs",
                  items: request._tag === "runs" && request.filters?.runId
                    ? rows.filter((run) => run.runId === request.filters?.runId)
                    : rows
                })
            })
          )
          if (offset <= 0) {
            expect((yield* eventsProjection.snapshot({ _tag: "run-events", runId: run.runId })).rows).toEqual(history)
            expect((yield* rowsProjection.snapshot({ _tag: "workspace-runs" })).rows).toEqual(expectedRows)
          } else {
            expect(yield* Effect.flip(eventsProjection.snapshot({ _tag: "run-events", runId: run.runId })))
              .toMatchObject({
                code: "resource_limit",
                message: `Run event history exceeds ${Projections.maxProjectionBytes} encoded bytes`
              })
            expect(yield* Effect.flip(rowsProjection.snapshot({ _tag: "workspace-runs" })))
              .toMatchObject({
                code: "resource_limit",
                message: `Projection rows exceed ${Projections.maxProjectionBytes} encoded bytes`
              })
          }
        }))
    }
  }

  it.effect("bounds encoded event histories and projected row sets", () =>
    Effect.gen(function*() {
      const oversizedEvents = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.succeed(event(1, "control.test", "x".repeat(Projections.maxProjectionBytes)))
      }))
      const oversizedRows = make(control({
        list: () =>
          Effect.succeed({
            _tag: "runs",
            items: [{ ...run, flowId: "x".repeat(Projections.maxProjectionBytes) }]
          })
      }))

      expect(
        (yield* Effect.flip(oversizedEvents.snapshot({ _tag: "run-events", runId: run.runId }))).code
      ).toBe("resource_limit")
      expect((yield* Effect.flip(oversizedRows.snapshot({ _tag: "workspace-runs" }))).code)
        .toBe("resource_limit")
    }))

  it.effect("refuses malformed and backward event histories as unavailable", () =>
    Effect.gen(function*() {
      const malformedEvents = [
        [{}],
        [{ ...event(1, "control.test", null), sequence: -1 }],
        [event(2, "control.test", null), event(1, "control.test", null)]
      ]
      for (const history of malformedEvents) {
        const projections = make(control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable(history as ReadonlyArray<ControlEvent>)
        }))
        const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-events", runId: run.runId }))
        expect(failure.code).toBe("run_unavailable")
      }
    }))

  it.effect("refuses a projection row that violates its selector schema", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: () =>
          Effect.succeed({
            _tag: "runs",
            items: [{ ...run, flowId: undefined }] as unknown as ReadonlyArray<RunSummary>
          })
      }))
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "workspace-runs" }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Projection produced invalid rows")
    }))
})

describe("Projections approvals inbox", () => {
  it.effect("collects the pending gates of every waiting run", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable([approvalRequested])
        })
      )
      const snapshot = yield* projections.snapshot({ _tag: "approvals" })
      expect(snapshot.rows).toMatchObject([{ runId: "run-1", requestId: "gate", status: "pending" }])
      // The workspace inbox is not scoped to a run, so its cursor names none.
      expect(snapshot.cursor).toEqual({
        selector: { _tag: "approvals" },
        projection: "approvals",
        runId: null,
        value: 0,
        offset: 0
      })
    }))
})

describe("Projections node output", () => {
  it.effect("answers only the node the selector named", () =>
    Effect.gen(function*() {
      const calls = [
        event(1, "control.agent.cell-call-started", { flowName: "write" }),
        event(2, "control.agent.cell-call-settled", { flowName: "write", outcome: "success", value: "wrote it" }),
        event(3, "control.agent.cell-call-started", { flowName: "read" }),
        event(4, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "read it" })
      ]
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: () => Stream.fromIterable(calls)
      }))

      expect((yield* projections.snapshot({ _tag: "node-output", runId: "run-1", nodeId: "call-2" })).rows)
        .toMatchObject([{ nodeId: "call-2", output: "read it" }])
      // A node the run never opened is an empty answer, not a refusal: the run
      // exists, and a client asking about a node it has not seen settle yet is
      // asking a question with an answer.
      expect((yield* projections.snapshot({ _tag: "node-output", runId: "run-1", nodeId: "call-9" })).rows)
        .toEqual([])
    }))
})

describe("Projections subscriptions", () => {
  const movingLog = () => {
    let nonFollowingReads = 0
    let log: ReadonlyArray<ControlEvent> = []
    const service = control({
      list: () => Effect.succeed({ _tag: "runs", items: [run] }),
      watch: (filter) => {
        if (filter.follow !== true) {
          nonFollowingReads += 1
          log = [...log, event(log.length, "control.run.accepted", { runId: "run-1" })]
          return Stream.fromIterable(log)
        }
        log = [...log, event(log.length, "control.run.completed", { runId: "run-1" })]
        return Stream.fromIterable(log.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
      }
    })
    return { reads: () => nonFollowingReads, service }
  }

  for (const tag of ["run-events", "run-summary", "run-tree", "transcript", "approvals"] as const) {
    it.effect(`uses one moving-log read for a ${tag} subscription`, () =>
      Effect.gen(function*() {
        const moving = movingLog()
        const projections = make(moving.service, { heartbeatMillis: 60_000 })
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: tag, runId: "run-1" }))
        const snapshotEnd = frames.find((frame) => frame._tag === "snapshot-end")
        const deltas = frames.filter((frame) => frame._tag === "delta")

        expect(moving.reads()).toBe(1)
        expect(snapshotEnd?._tag).toBe("snapshot-end")
        if (snapshotEnd?._tag !== "snapshot-end") return
        expect(deltas.length).toBeGreaterThan(0)
        expect(deltas.every((frame) => frame.cursor.value > snapshotEnd.cursor.value)).toBe(true)

        if (tag === "run-events") {
          const snapshotSequences = frames.flatMap((frame) =>
            frame._tag === "row" ? [(frame.row as ControlEvent).sequence] : []
          )
          const deltaSequences = deltas.flatMap((frame) =>
            (frame.delta as ReadonlyArray<ControlEvent>).map((item) => item.sequence)
          )
          expect(snapshotSequences.filter((sequence) => deltaSequences.includes(sequence))).toEqual([])
        }
      }))
  }

  it.effect("uses one moving-log read for a unary snapshot cursor and rows", () =>
    Effect.gen(function*() {
      const moving = movingLog()
      const snapshot = yield* make(moving.service).snapshot({ _tag: "run-events", runId: "run-1" })
      const rows = snapshot.rows as ReadonlyArray<ControlEvent>
      expect(moving.reads()).toBe(1)
      expect(snapshot.cursor.value).toBe(rows.at(-1)?.sequence)
    }))

  it.effect("reads each run's non-following log exactly once per snapshot", () =>
    Effect.gen(function*() {
      const second = { ...run, runId: "run-2" }
      const reads: Array<string> = []
      const projections = make(control({
        list: (request) => {
          const named = request._tag === "runs" ? request.filters?.runId : undefined
          return Effect.succeed(
            {
              _tag: "runs",
              items: named === undefined ? [run, second] : [run, second].filter((item) => item.runId === named)
            } satisfies ListResponse
          )
        },
        watch: (filter) => {
          if (filter.follow !== true && filter.runId !== undefined) reads.push(filter.runId)
          return Stream.empty
        }
      }))

      yield* projections.snapshot({ _tag: "run-summary", runId: "run-1" })
      expect(reads).toEqual(["run-1"])
      reads.length = 0
      yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(reads.sort()).toEqual(["run-1", "run-2"])
    }))

  it.effect("accumulates fifty run-tree deltas without re-reading history", () =>
    Effect.gen(function*() {
      const followed = Array.from({ length: 50 }, (_, index) =>
        event(index + 1, "control.agent.cell-call-started", { flowName: `call-${index + 1}` }))
      let history: ReadonlyArray<ControlEvent> = []
      let nonFollowingReads = 0
      let listCalls = 0
      const projections = make(
        control({
          list: () => {
            listCalls += 1
            return Effect.succeed({ _tag: "runs", items: [run] })
          },
          watch: (filter) => {
            if (filter.follow !== true) {
              nonFollowingReads += 1
              return Stream.fromIterable(history)
            }
            history = followed
            return Stream.fromIterable(followed)
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "run-tree", runId: "run-1" }))
      const deltas = frames.filter((frame) =>
        frame._tag === "delta"
      )
      expect(nonFollowingReads).toBe(1)
      expect(listCalls).toBe(52)
      expect(deltas).toHaveLength(50)

      const fresh = yield* projections.snapshot({ _tag: "run-tree", runId: "run-1" })
      expect(nonFollowingReads).toBe(2)
      expect(deltas.at(-1)?.delta).toEqual(fresh.rows)
    }))

  it.effect("delivers workspace deltas with the workspace cursor", () =>
    Effect.gen(function*() {
      const completed: RunSummary = { ...run, status: "completed", updatedAt: 3 }
      const planEvent: ControlEvent = {
        sequence: 1,
        kind: "control.plan.created",
        occurredAt: 1,
        payload: { planId: "plan-1" }
      }
      const changed = event(1, "control.run.completed", { runId: run.runId })
      const projections = make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === run.runId ? [completed] : [run]
            }),
          watch: (filter) => filter.follow === true ? Stream.fromIterable([planEvent, changed]) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Without the unscoped follow, a dashboard keeps the snapshot's stale
      // waiting status after the control row has completed under a fence.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.cursor).toEqual({
        selector: { _tag: "workspace-runs" },
        projection: "workspace-runs",
        runId: null,
        value: 0,
        offset: 0
      })
      expect(delta.delta).toMatchObject([{ runId: "run-1", status: "completed", verdict: "completed" }])
    }))

  it.effect("admits a newly followed run with one journal read", () =>
    Effect.gen(function*() {
      const second = { ...numberedRun(2), status: "running" } satisfies RunSummary
      const accepted: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: second.runId }),
        runId: second.runId
      }
      let nonFollowingReads = 0
      const projections = make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === second.runId ? [second] : []
            }),
          watch: (filter) => {
            if (filter.follow === true) return Stream.fromIterable([accepted])
            nonFollowingReads += 1
            return Stream.fromIterable([accepted])
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Re-listing or re-reading the whole workspace for one new run turns a
      // live dashboard into work proportional to workspace size per event.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.delta).toMatchObject([{ runId: "run-2", status: "running" }])
      expect(nonFollowingReads).toBe(1)
    }))

  it.effect("suppresses the replayed workspace prefix", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.run.accepted", { runId: run.runId }),
        event(1, "control.lineage.disclosed", { runId: run.runId }),
        event(2, "control.run.running", { runId: run.runId })
      ]
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: () => Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      // An unscoped control follow replays every partition. Re-emitting that
      // prefix would send rows the snapshot already delivered.
      expect(frames.filter((frame) => frame._tag === "delta")).toEqual([])
    }))

  it.effect("skips an unlistable followed run without ending the workspace subscription", () =>
    Effect.gen(function*() {
      const second = { ...numberedRun(2), status: "running" } satisfies RunSummary
      const missing: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: "run-missing" }),
        runId: "run-missing"
      }
      const accepted: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: second.runId }),
        runId: second.runId
      }
      const projections = make(
        control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: request._tag === "runs" && request.filters?.runId === second.runId ? [second] : []
            }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable([missing, accepted])
              : filter.runId === second.runId
              ? Stream.fromIterable([accepted])
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      // A journal notification can race visibility in the run listing. That
      // one row must not kill the subscription before the next visible run.
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toMatchObject([{ runId: "run-2" }])
    }))

  it.effect("keeps followed workspace rows within the workspace ceiling", () =>
    Effect.gen(function*() {
      const initial = Array.from({ length: Projections.maxWorkspaceRuns }, (_, index) => numberedRun(index + 1))
      const extra = numberedRun(Projections.maxWorkspaceRuns + 1)
      const accepted: ControlEvent = {
        ...event(1, "control.run.accepted", { runId: extra.runId }),
        runId: extra.runId
      }
      const projections = make(
        control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            return Effect.succeed({
              _tag: "runs",
              items: named === extra.runId
                ? [extra]
                : named === undefined
                ? initial
                : initial.filter((run) => run.runId === named)
            })
          },
          watch: (filter) =>
            filter.follow === true || filter.runId === extra.runId ? Stream.fromIterable([accepted]) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      const rowIds = frames.flatMap((frame) =>
        frame._tag === "row" ? [(frame.row as { readonly runId: string }).runId] : []
      )
      // Admitting beyond the documented ceiling makes one long-lived stream
      // consume more journals than the bounded snapshot contract allows.
      expect(rowIds).toHaveLength(Projections.maxWorkspaceRuns)
      expect(rowIds).not.toContain(extra.runId)
      expect(frames.filter((frame) => frame._tag === "delta")).toEqual([])
    }))

  it.effect("delivers new gates to an unscoped approvals inbox", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => filter.follow === true ? Stream.fromIterable([approvalRequested]) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const delta = frames.find((frame) => frame._tag === "delta")
      // Without workspace deltas, an operator never sees a gate requested
      // after the approvals inbox snapshot was read.
      expect(delta?._tag).toBe("delta")
      if (delta?._tag !== "delta") return
      expect(delta.cursor).toEqual({
        selector: { _tag: "approvals" },
        projection: "approvals",
        runId: null,
        value: 0,
        offset: 0
      })
      expect(delta.delta).toMatchObject([{ runId: "run-1", requestId: "gate", status: "pending" }])
    }))

  it.effect("removes a resolved run from the live approvals inbox", () =>
    Effect.gen(function*() {
      const approved = event(2, "control.approval.approved", { tokenId: "gate" })
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable([approvalRequested, approved])
              : Stream.fromIterable([approvalRequested])
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toEqual([])
    }))

  it.effect("remembers irrelevant histories and missing plan partitions during replay", () =>
    Effect.gen(function*() {
      for (const selector of [{ _tag: "approvals" }, { _tag: "workspace-runs" }] as const) {
        let reads = 0
        let missingLookups = 0
        const history = Array.from({ length: 20 }, (_, index) => event(index >> 1, "control.run.completed", null))
        const plans = history.map((item) => ({ ...item, runId: "plan:missing" }))
        const projections = make(control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            if (named === "plan:missing") missingLookups += 1
            return Effect.succeed({
              _tag: "runs",
              items: named === run.runId ? [{ ...run, status: "completed" }] : []
            })
          },
          watch: (filter) => {
            if (filter.follow) return Stream.fromIterable([...history, ...plans])
            reads += 1
            return Stream.fromIterable(history)
          }
        }))
        yield* Stream.runDrain(projections.subscribe(selector))
        expect(reads).toBe(1)
        expect(missingLookups).toBe(1)
      }
    }))

  it.effect("removes cancelled runs with pending gates and rejects them on admission", () =>
    Effect.gen(function*() {
      for (const seeded of [true, false]) {
        let following = false
        const cancelled = event(2, "control.run.cancelled", { runId: run.runId })
        const projections = make(control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            const current: RunSummary = following ? { ...run, status: "cancelled" } : run
            return Effect.succeed({
              _tag: "runs",
              items: named === undefined
                ? seeded && current.status === "waiting-approval" ? [current] : []
                : [current]
            })
          },
          watch: (filter) => {
            if (!filter.follow) return Stream.fromIterable([approvalRequested])
            following = true
            return Stream.fromIterable([approvalRequested, cancelled])
          }
        }))
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
        const deltas = frames.filter((frame) => frame._tag === "delta")
        expect(deltas.map((frame) => frame.delta)).toEqual(seeded ? [[]] : [])
        expect((yield* projections.snapshot({ _tag: "approvals" })).rows).toEqual([])
      }
    }))

  it.effect("checks reconciled status before admitting a snapshot gate", () =>
    Effect.gen(function*() {
      const projections = make(control({
        list: (request) =>
          Effect.succeed({
            _tag: "runs",
            items: [request._tag === "runs" && request.filters?.runId ? { ...run, status: "cancelled" } : run]
          }),
        watch: () => Stream.fromIterable([approvalRequested])
      }))
      expect((yield* projections.snapshot({ _tag: "approvals" })).rows).toEqual([])
    }))

  // Live clock: the parking event must arrive after the first coalesced batch
  // has judged the run, or the follower never holds a verdict to reconsider.
  it.live("reconsiders a judged run when it parks on a pending approval", () =>
    Effect.gen(function*() {
      let parked = false
      let reads = 0
      let lookups = 0
      const judged = yield* Deferred.make<void>()
      const waiting = event(2, "control.run.waiting-approval", { runId: run.runId })
      const projections = make(control({
        list: (request) =>
          Effect.gen(function*() {
            const named = request._tag === "runs" && request.filters?.runId !== undefined
            // The second named lookup is the reconciling re-read that ends the
            // first admission, so the verdict is settled before the run parks.
            if (named && (lookups += 1) === 2) yield* Deferred.succeed(judged, undefined)
            return {
              _tag: "runs",
              items: named ? [{ ...run, status: parked ? "waiting-approval" : "running" }] : []
            } satisfies ListResponse
          }),
        watch: (filter) => {
          if (!filter.follow) {
            reads += 1
            return Stream.fromIterable(parked ? [approvalRequested, waiting] : [approvalRequested])
          }
          return Stream.concat(
            Stream.succeed(approvalRequested),
            Stream.fromEffect(Effect.map(Deferred.await(judged), () => {
              parked = true
              return waiting
            }))
          )
        }
      }))
      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(reads).toBe(2)
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toMatchObject([{ requestId: "gate", status: "pending" }])
    }))

  it.effect("bounds retained workspace state across ignored and removed runs", () =>
    Effect.gen(function*() {
      const count = Projections.maxWorkspaceRuns * 2 + 1
      const summaries = new Map<string, RunSummary>()
      const histories = new Map<string, ReadonlyArray<ControlEvent>>()
      const followed: Array<ControlEvent> = []
      for (let index = 0; index < count; index += 1) {
        const runId = `retained-${index}`
        const relevant = index % 2 === 0
        summaries.set(runId, { ...run, runId, status: relevant ? "waiting-approval" : "completed" })
        const first = relevant
          ? { ...approvalRequested, runId }
          : { ...event(1, "control.run.completed", null), runId }
        histories.set(runId, [first])
        followed.push(first)
        if (relevant) followed.push({ ...event(2, "control.approval.approved", { tokenId: "gate" }), runId })
      }
      const NativeMap = globalThis.Map
      let peak = 0
      class ObservedMap<K, V> extends NativeMap<K, V> {
        override set(key: K, value: V): this {
          super.set(key, value)
          if (typeof key === "string" && key.startsWith("retained-")) peak = Math.max(peak, this.size)
          return this
        }
      }
      const projections = make(control({
        list: (request) => {
          const named = request._tag === "runs" ? request.filters?.runId : undefined
          return Effect.succeed({ _tag: "runs", items: named === undefined ? [] : [summaries.get(named)!] })
        },
        watch: (filter) => Stream.fromIterable(filter.follow ? followed : histories.get(filter.runId!) ?? [])
      }))
      try {
        globalThis.Map = ObservedMap
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
        const deltas = frames.filter((frame) => frame._tag === "delta")
        // 1502 followed events span two coalesced batches of 1024, and every
        // admitted gate was approved by the end, so the inbox finishes empty.
        expect(deltas).toHaveLength(2)
        expect(deltas.at(-1)?.delta).toEqual([])
        expect(peak).toBeGreaterThan(0)
        expect(peak).toBeLessThanOrEqual(Projections.maxWorkspaceRuns)
      } finally {
        globalThis.Map = NativeMap
      }
    }))

  it.effect("checks workspace replay positions without scanning the retained history", () =>
    Effect.gen(function*() {
      const history = Array.from({ length: 200 }, (_, index) => event(index >> 1, "control.run.accepted", null))
      let following = false
      let visits = 0
      const originalMap = Array.prototype.map
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: (filter) => {
          if (filter.follow) following = true
          return Stream.fromIterable(history)
        }
      }))
      try {
        Array.prototype.map = function(this: Array<ControlEvent>, callback, thisArg) {
          if (following && this.length === history.length && this[0]?.kind === "control.run.accepted") {
            visits += this.length
          }
          return originalMap.call(this, callback, thisArg)
        } as typeof Array.prototype.map
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
        expect(frames.filter((frame) => frame._tag === "delta")).toEqual([])
        expect(visits).toBe(0)
      } finally {
        Array.prototype.map = originalMap
      }
    }))

  it.effect("does not let irrelevant followed runs exhaust the approvals inbox", () =>
    Effect.gen(function*() {
      const irrelevant = Array.from({ length: Projections.maxWorkspaceRuns }, (_, index) => {
        const runId = `completed-${index + 1}`
        return {
          run: { ...numberedRun(index + 1), runId, status: "completed" as const },
          event: { ...event(1, "control.run.completed", { runId }), runId }
        }
      })
      const waiting = { ...run, runId: "waiting-last" }
      const requested = {
        sequence: 1,
        kind: "control.approval.requested",
        runId: waiting.runId,
        occurredAt: 1,
        payload: {
          runId: waiting.runId,
          requestId: "gate",
          question: "Ship?",
          payload: {
            target: {
              _tag: "Node",
              runId: waiting.runId,
              requestId: "gate",
              digest: "d",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: "k"
          }
        }
      } satisfies ControlEvent
      const histories = new Map<string, ReadonlyArray<ControlEvent>>([
        ...irrelevant.map(({ event }) => [event.runId!, [event]] as const),
        [waiting.runId, [requested]]
      ])
      const summaries = new Map([
        ...irrelevant.map(({ run }) => [run.runId, run] as const),
        [waiting.runId, waiting]
      ])
      const projections = make(
        control({
          list: (request) => {
            const runId = request._tag === "runs" ? request.filters?.runId : undefined
            return Effect.succeed({
              _tag: "runs",
              items: runId === undefined ? [] : [summaries.get(runId)!]
            })
          },
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable([...irrelevant.map(({ event }) => event), requested])
              : Stream.fromIterable(histories.get(filter.runId ?? "") ?? [])
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.delta).toMatchObject([{ runId: waiting.runId, requestId: "gate", status: "pending" }])
    }))

  it.effect("keeps the approvals inbox at its ceiling when every admitted run is relevant", () =>
    Effect.gen(function*() {
      const requestFor = (runId: string): ControlEvent => ({
        sequence: 1,
        kind: "control.approval.requested",
        runId,
        occurredAt: 1,
        payload: {
          runId,
          requestId: `gate-${runId}`,
          question: "Ship?",
          payload: {
            target: {
              _tag: "Node",
              runId,
              requestId: `gate-${runId}`,
              digest: "d",
              envelope: { capabilities: [], flows: [], budget: {} }
            },
            scope: "run",
            idempotencyKey: `approve:${runId}`
          }
        }
      })
      const initial = Array.from({ length: Projections.maxWorkspaceRuns }, (_, index) => ({
        ...numberedRun(index + 1),
        status: "waiting-approval" as const
      }))
      const extra = { ...numberedRun(Projections.maxWorkspaceRuns + 1), status: "waiting-approval" as const }
      const histories = new Map(initial.map((item) => [item.runId, [requestFor(item.runId)]] as const))
      histories.set(extra.runId, [requestFor(extra.runId)])
      const projections = make(
        control({
          list: (request) => {
            const named = request._tag === "runs" ? request.filters?.runId : undefined
            return Effect.succeed({
              _tag: "runs",
              items: named === extra.runId
                ? [extra]
                : named === undefined
                ? initial
                : initial.filter((run) => run.runId === named)
            })
          },
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(histories.get(extra.runId)!)
              : Stream.fromIterable(histories.get(filter.runId ?? "") ?? [])
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "approvals" }))
      expect(frames.filter((frame) => frame._tag === "row")).toHaveLength(Projections.maxWorkspaceRuns)
      expect(frames.filter((frame) => frame._tag === "delta")).toEqual([])
    }))

  it.effect("resumes after a run cursor without emitting snapshot frames", () =>
    Effect.gen(function*() {
      const history = [
        event(0, "control.run.accepted", { runId: "run-1" }),
        event(1, "control.run.running", { runId: "run-1" }),
        event(2, "control.run.completed", { runId: "run-1" })
      ]
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        issuedCursor({ _tag: "run-events", runId: "run-1" }, 0)
      ))
      expect(frames.map((frame) => frame._tag)).toEqual(["delta", "delta"])
      expect(frames.flatMap((frame) => frame._tag === "delta" ? [frame.cursor.value] : [])).toEqual([1, 2])
      // The fold is seeded with the events up to the cursor, so a resumed
      // subscription is not a projection of the tail alone.
      expect(frames.flatMap((frame) => frame._tag === "delta" ? [frame.delta] : [])).toEqual([
        [history[1]],
        [history[2]]
      ])
    }))

  it.effect("resumes within one journal sequence without dropping derived events", () =>
    Effect.gen(function*() {
      const history = [
        event(0, "control.run.accepted", { runId: "run-1" }),
        event(0, "control.lineage.disclosed", { runId: "run-1" }),
        event(1, "control.run.running", { runId: "run-1" })
      ]
      const selector = { _tag: "run-events" as const, runId: "run-1" }
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const suffix = yield* projections.snapshot(selector, issuedCursor(selector, 0, 0))
      expect(suffix.rows).toEqual([history[1], history[2]])
      expect(suffix.cursor).toEqual(issuedCursor(selector, 1, 0))
      const summarySelector = { _tag: "run-summary" as const, runId: "run-1" }
      const refused = yield* Effect.flip(projections.snapshot(summarySelector, issuedCursor(summarySelector, 0, 0)))
      expect(refused.code).toBe("malformed_request")

      const frames = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 0, 0)))
      expect(frames.flatMap((frame) => frame._tag === "delta" ? [[frame.cursor.value, frame.cursor.offset]] : []))
        .toEqual([[0, 1], [1, 0]])
      expect(frames.flatMap((frame) => frame._tag === "delta" ? frame.delta as ReadonlyArray<ControlEvent> : []))
        .toEqual([
          history[1],
          history[2]
        ])
    }))

  it.effect("refuses a node-output cursor for a different node in the same run", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.agent.cell-call-started", { flowName: "one" }),
        event(2, "control.agent.cell-call-settled", { flowName: "one", outcome: "success", value: "one" }),
        event(3, "control.agent.cell-call-started", { flowName: "two" }),
        event(4, "control.agent.cell-call-settled", { flowName: "two", outcome: "success", value: "two" })
      ]
      let follows = 0
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: (filter) => {
          if (filter.follow === true) follows += 1
          return filter.follow === true ? Stream.empty : Stream.fromIterable(history)
        }
      }))
      const first = { _tag: "node-output" as const, runId: "run-1", nodeId: "call-1" }
      const second = { ...first, nodeId: "call-2" }
      const cursor = (yield* projections.snapshot(first)).cursor
      const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(second, cursor)))

      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("exact selector")
      expect(follows).toBe(0)
    }))

  it.effect("refuses negative and fractional resume cursor values before following", () =>
    Effect.gen(function*() {
      const history = [event(1, "control.run.accepted", { runId: "run-1" })]
      let follows = 0
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow !== true) return Stream.fromIterable(history)
            follows += 1
            return Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      for (const value of [-1, 0.5]) {
        const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
          { _tag: "run-events", runId: "run-1" },
          issuedCursor({ _tag: "run-events", runId: "run-1" }, value)
        )))
        expect(failure.code).toBe("malformed_request")
        expect(failure.message).toContain(String(value))
      }
      expect(follows).toBe(0)
    }))

  it.effect("refuses invalid offsets and structurally incomplete cursors before following", () =>
    Effect.gen(function*() {
      let follows = 0
      const projections = make(control({
        list: () => Effect.succeed({ _tag: "runs", items: [run] }),
        watch: (filter) => {
          if (filter.follow === true) follows += 1
          return Stream.empty
        }
      }))
      const selector = { _tag: "run-events" as const, runId: "run-1" }
      const invalid = [
        { ...issuedCursor(selector, 0), offset: -1 },
        { projection: "run-events", runId: "run-1", value: 0, offset: 0 }
      ]
      const messages: Array<string> = []
      for (const cursor of invalid) {
        const failure = yield* Effect.flip(
          Stream.runCollect(projections.subscribe(selector, cursor as GatewaySchema.ProjectionCursor))
        )
        messages.push(failure.message)
      }
      expect(messages[0]).toContain("offset -1")
      expect(messages[1]).toContain("not a valid gateway cursor")
      expect(follows).toBe(0)
    }))

  it.effect("accepts the zero origin and refuses a position the run never issued", () =>
    Effect.gen(function*() {
      const history = [event(1, "control.run.accepted", { runId: "run-1" })]
      const selector = { _tag: "run-events" as const, runId: "run-1" }
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.fromIterable(history)
        }),
        { heartbeatMillis: 60_000 }
      )

      const resumed = yield* Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 0)))
      expect(resumed.flatMap((frame) => frame._tag === "delta" ? [frame.cursor.value] : [])).toEqual([1])
      const failure = yield* Effect.flip(
        Stream.runCollect(projections.subscribe(selector, issuedCursor(selector, 0, 1)))
      )
      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("was not issued")
    }))

  it.effect("refuses a resume cursor ahead of the run's last sequence", () =>
    Effect.gen(function*() {
      const history = [
        event(1, "control.run.accepted", { runId: "run-1" }),
        event(2, "control.run.running", { runId: "run-1" })
      ]
      let follows = 0
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow !== true) return Stream.fromIterable(history)
            follows += 1
            return Stream.empty
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        issuedCursor({ _tag: "run-events", runId: "run-1" }, 3)
      )))
      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("3")
      expect(failure.message).toContain("2")
      expect(follows).toBe(0)
    }))

  it.effect("refuses a positive resume cursor for a run with no events", () =>
    Effect.gen(function*() {
      let follows = 0
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => {
            if (filter.follow === true) follows += 1
            return Stream.empty
          }
        }),
        { heartbeatMillis: 60_000 }
      )

      const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(
        { _tag: "run-events", runId: "run-1" },
        issuedCursor({ _tag: "run-events", runId: "run-1" }, 1)
      )))
      expect(failure.code).toBe("malformed_request")
      expect(failure.message).toContain("1")
      expect(failure.message).toContain("0")
      expect(follows).toBe(0)
    }))

  for (
    const [name, selector, after, message] of [
      [
        "a different projection",
        { _tag: "run-events", runId: "run-1" },
        issuedCursor({ _tag: "transcript", runId: "run-1" }, 1),
        "projection"
      ],
      [
        "a different run",
        { _tag: "run-events", runId: "run-1" },
        { ...issuedCursor({ _tag: "run-events", runId: "run-1" }, 1), runId: "run-2" },
        "run"
      ],
      [
        "a different selector tag with the same projection field",
        { _tag: "run-events", runId: "run-1" },
        { ...issuedCursor({ _tag: "transcript", runId: "run-1" }, 1), projection: "run-events" },
        "exact selector"
      ],
      [
        "a different approval selector with the same run field",
        { _tag: "approvals", runId: "run-1" },
        { ...issuedCursor({ _tag: "approvals", runId: "run-2" }, 1), runId: "run-1" },
        "exact selector"
      ],
      [
        "a workspace projection",
        { _tag: "workspace-runs" },
        issuedCursor({ _tag: "workspace-runs" }, 0),
        "workspace"
      ],
      [
        "a cursor that names no run",
        { _tag: "run-events", runId: "run-1" },
        { ...issuedCursor({ _tag: "run-events", runId: "run-1" }, 1), runId: null },
        "for run none"
      ]
    ] as const satisfies ReadonlyArray<
      readonly [
        string,
        GatewaySchema.ProjectionSelector,
        GatewaySchema.ProjectionCursor,
        string
      ]
    >
  ) {
    it.effect(`refuses a resume cursor for ${name}`, () =>
      Effect.gen(function*() {
        const projections = make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [run] })
          }),
          { heartbeatMillis: 60_000 }
        )
        const failure = yield* Effect.flip(Stream.runCollect(Stream.take(projections.subscribe(selector, after), 1)))
        expect(failure.code).toBe("malformed_request")
        expect(failure.message).toContain(message)
      }))
  }

  it.live("keeps a workspace subscription open on keepalives alone", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [] }),
          watch: (filter) => filter.follow === true ? Stream.never : Stream.empty
        }),
        { heartbeatMillis: 1 }
      )
      const frames = yield* Stream.runCollect(
        Stream.take(projections.subscribe({ _tag: "workspace-runs" }), 3)
      )
      // An empty workspace produces no delta, so the keepalive is what proves
      // its live follow remains connected while there is nothing to report.
      expect(frames.map((frame) => frame._tag)).toEqual(["snapshot-start", "snapshot-end", "heartbeat"])
      const heartbeat = frames[2]
      expect(heartbeat?._tag === "heartbeat" && typeof heartbeat.atMs).toBe("number")
    }))

  it.live("emits every declared gateway frame tag through subscriptions", () =>
    Effect.gen(function*() {
      const runFrames = yield* Stream.runCollect(
        make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [run] }),
            watch: (filter) =>
              filter.follow === true
                ? Stream.fromIterable([event(2, "control.run.completed", { runId: "run-1" })])
                : Stream.fromIterable([approvalRequested])
          }),
          { heartbeatMillis: 60_000 }
        ).subscribe({ _tag: "run-summary", runId: "run-1" })
      )
      const workspaceFrames = yield* Stream.runCollect(Stream.take(
        make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: [] }),
            watch: (filter) => filter.follow === true ? Stream.never : Stream.empty
          }),
          { heartbeatMillis: 1 }
        ).subscribe({ _tag: "workspace-runs" }),
        3
      ))
      const emitted = new Set([...runFrames, ...workspaceFrames].map((frame) => frame._tag))
      const declared = new Set(
        GatewaySchema.GatewayFrame.members.map((member) => member.fields._tag.schema.literal)
      )
      expect(emitted).toEqual(declared)
    }))
})

describe("Projections delta failures", () => {
  it.effect("refuses backward sequences on run and workspace follows", () =>
    Effect.gen(function*() {
      const backward = [event(2, "control.test", null), event(1, "control.test", null)]
      for (
        const selector of [
          { _tag: "run-events" as const, runId: "run-1" },
          { _tag: "workspace-runs" as const }
        ]
      ) {
        const projections = make(
          control({
            list: () => Effect.succeed({ _tag: "runs", items: selector._tag === "workspace-runs" ? [] : [run] }),
            watch: (filter) => filter.follow === true ? Stream.fromIterable(backward) : Stream.empty
          }),
          { heartbeatMillis: 60_000 }
        )
        const failure = yield* Effect.flip(Stream.runCollect(projections.subscribe(selector)))
        expect(failure.code).toBe("run_unavailable")
        expect(failure.message).toContain("moved backward")
      }
    }))

  it.effect("reports a follow that broke mid-stream as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-3" }))
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )
      const failure = yield* Effect.flip(
        Stream.runCollect(projections.subscribe({ _tag: "run-summary", runId: "run-1" }))
      )
      expect(failure.message).toBe("Following run-1 failed")
    }))

  it.effect("reports a workspace follow that broke mid-stream as a gateway refusal", () =>
    Effect.gen(function*() {
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [] }),
          watch: (filter) =>
            filter.follow === true
              ? Stream.fail(new Unavailable({ code: "unavailable", feature: "watch", ticket: "T-4" }))
              : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )
      // A broken workspace follow must become a typed refusal. Leaving the
      // snapshot open on keepalives would silently freeze every workspace view.
      const failure = yield* Effect.flip(
        Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
      )
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toBe("Following the workspace failed")
      expect(failure.cause).toEqual({ _tag: "/control/Unavailable", code: "unavailable" })
    }))
})

describe("Projections keepalive cadence", () => {
  it("stays under the relay's idle cut with margin", () => {
    // the deployed relay behavior: the relay drops an idle tunnel at 600 s.
    expect(Projections.heartbeatIntervalMillis).toBeLessThan(600_000 / 2)
  })
})

describe("snapshot read regressions", () => {
  for (
    const selector of [
      { _tag: "run-summary" as const, runId: "run-1" },
      { _tag: "workspace-runs" as const }
    ]
  ) {
    it.effect(`reconciles a completion during the ${selector._tag} history read`, () =>
      Effect.gen(function*() {
        let current: RunSummary = { ...run, status: "running" }
        const projections = make(control({
          list: () => Effect.succeed({ _tag: "runs", items: [current] }),
          watch: () =>
            Stream.unwrap(Effect.sync(() => {
              current = { ...current, status: "completed", updatedAt: 3 }
              return Stream.fromIterable([
                event(0, "control.run.running", { status: "running" }),
                event(1, "control.run.completed", { status: "completed" })
              ])
            }))
        }))
        const snapshot = yield* projections.snapshot(selector)
        expect(snapshot.rows[0]).toMatchObject({ status: "completed" })
        expect(snapshot.cursor.value).toBe(selector._tag === "run-summary" ? 1 : 0)
      }))
  }

  for (const resume of [false, true]) {
    it.effect(`delivers sequence zero from an empty seed (resume=${resume})`, () =>
      Effect.gen(function*() {
        const history = [event(0, "control.run.accepted", null), event(1, "control.run.running", null)]
        const selector = { _tag: "run-events" as const, runId: run.runId }
        const projections = make(control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            filter.follow
              ? Stream.fromIterable(history.filter((item) => item.sequence > (filter.afterSequence ?? -1)))
              : Stream.empty
        }))
        const frames = yield* Stream.runCollect(
          projections.subscribe(selector, resume ? issuedCursor(selector, 0) : undefined)
        )
        expect(frames.flatMap<unknown>((frame) => frame._tag === "delta" ? frame.delta : [])).toEqual(history)
      }))
  }

  for (const mode of ["empty", "repeated", "cycle", "duplicate"] as const) {
    it.effect(`stops ${mode} list pagination`, () =>
      Effect.gen(function*() {
        let calls = 0
        const projections = make(control({
          list: (request) => {
            if (request._tag === "runs" && request.filters?.runId) {
              return Effect.succeed({
                _tag: "runs",
                items: [numberedRun(Number(request.filters.runId.slice(4)))]
              })
            }
            calls += 1
            return Effect.succeed({
              _tag: "runs",
              items: mode === "empty" ? [] : [numberedRun(mode === "duplicate" ? 1 : calls)],
              ...(calls >= 4
                ? {}
                : { nextCursor: (mode === "cycle" || mode === "duplicate") && calls === 2 ? "b" : "a" })
            })
          }
        }))
        yield* projections.snapshot({ _tag: "workspace-runs" })
        expect(calls).toBe(mode === "empty" ? 1 : mode === "repeated" || mode === "duplicate" ? 2 : 3)
      }))
  }

  it.effect("reads workspace journals with concurrency bounded at eight", () =>
    Effect.gen(function*() {
      const runs = Array.from({ length: 12 }, (_, index) => numberedRun(index + 1))
      let active = 0
      let peak = 0
      const projections = make(control({
        list: (request) =>
          Effect.succeed({
            _tag: "runs",
            items: request._tag === "runs" && request.filters?.runId
              ? runs.filter((run) => run.runId === request.filters?.runId) :
              runs
          }),
        watch: () =>
          Stream.unwrap(Effect.gen(function*() {
            active += 1
            peak = Math.max(peak, active)
            yield* Effect.yieldNow
            active -= 1
            return Stream.empty
          }))
      }))
      const snapshot = yield* projections.snapshot({ _tag: "workspace-runs" })
      expect(snapshot.rows).toHaveLength(12)
      expect(peak).toBe(8)
    }))

  for (const operation of ["list", "history", "run-follow", "workspace-follow"] as const) {
    it.effect(`redacts ${operation} logger output`, () =>
      Effect.gen(function*() {
        const secret = "synthetic-private-credential"
        const failure = new PersistenceError({ operation: secret, message: secret, cause: { password: secret } })
        const messages: Array<unknown> = []
        const projections = make(control({
          list: () => operation === "list" ? Effect.fail(failure) : Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) => operation === "history" || filter.follow ? Stream.fail(failure) : Stream.empty
        }))
        const selector = operation === "workspace-follow" ?
          { _tag: "workspace-runs" as const }
          : { _tag: "run-events" as const, runId: run.runId }
        const result = yield* Effect.flip(
          operation.endsWith("follow")
            ? Stream.runCollect(projections.subscribe(selector)).pipe(Effect.asVoid) :
            projections.snapshot(selector).pipe(Effect.asVoid)
        ).pipe(
          Effect.provide(Logger.layer([Logger.make(({ message }) => {
            messages.push(message)
          })]))
        )
        expect(result.code).toBe("run_unavailable")
        expect(messages).toHaveLength(1)
        expect(JSON.stringify(messages)).not.toContain(secret)
        expect(JSON.stringify(messages)).toContain("persistence_failed")
      }))
  }
})

describe("snapshot reconciliation bounds", () => {
  it.effect("refuses a run summary that changes throughout all eight attempts", () =>
    Effect.gen(function*() {
      let reads = 0
      const projections = make(control({
        list: () => Effect.sync(() => ({ _tag: "runs" as const, items: [{ ...run, updatedAt: reads++ }] }))
      }))
      const failure = yield* Effect.flip(projections.snapshot({ _tag: "run-summary", runId: run.runId }))
      expect(failure.code).toBe("run_unavailable")
      expect(failure.message).toContain("changed throughout")
      expect(reads).toBe(9)
    }))

  it.effect("does not log arbitrary backend tags or codes", () =>
    Effect.gen(function*() {
      const messages: Array<unknown> = []
      for (
        const failure of [
          { _tag: "private-tag", code: "private-code" },
          { _tag: "/control/PersistenceError", code: "private-code" },
          { _tag: "/control/Unavailable", code: "private-code" },
          "private-string"
        ]
      ) {
        yield* Effect.flip(
          make(control({ list: () => Effect.fail(failure as unknown as Unavailable) }))
            .snapshot({ _tag: "workspace-runs" })
        ).pipe(
          Effect.provide(Logger.layer([Logger.make(({ message }) => {
            messages.push(message)
          })]))
        )
      }
      expect(messages).toHaveLength(4)
      expect(JSON.stringify(messages)).not.toContain("private-")
    }))

  for (const listed of [false, true]) {
    it.effect(`admits sequence zero to an empty workspace journal (listed=${listed})`, () =>
      Effect.gen(function*() {
        const projections = make(control({
          list: (request) =>
            Effect.succeed({
              _tag: "runs",
              items: listed || request._tag === "runs" && request.filters?.runId ? [run] : []
            }),
          watch: (filter) =>
            filter.follow ? Stream.fromIterable([event(0, "control.run.accepted", null)]) : Stream.empty
        }))
        const frames = yield* Stream.runCollect(projections.subscribe({ _tag: "workspace-runs" }))
        expect(frames.filter((frame) => frame._tag === "delta")).toHaveLength(1)
      }))
  }
})

describe("Projections delta cost", () => {
  it.effect("coalesces a workspace burst into one frame and re-reads only the changed runs", () =>
    Effect.gen(function*() {
      const runs = Array.from(
        { length: Projections.maxWorkspaceRuns },
        (_, index): RunSummary => ({ ...numberedRun(index + 1), status: "running" })
      )
      const byId = new Map(runs.map((candidate) => [candidate.runId, candidate]))
      const changedRuns = runs.slice(0, 5)
      const burst = changedRuns.flatMap((changed) =>
        Array.from({ length: 20 }, (_, index): ControlEvent => ({
          ...event(index + 1, "control.agent.turn-opened", { runId: changed.runId, seat: "opus" }),
          runId: changed.runId
        }))
      )
      let runLookups = 0
      let lookupsAtSnapshotEnd = 0
      const projections = make(
        control({
          list: (request) =>
            Effect.sync((): ListResponse => {
              if (request._tag !== "runs") return { _tag: "runs", items: [] }
              const runId = request.filters?.runId
              if (runId === undefined) return { _tag: "runs", items: runs }
              runLookups += 1
              const found = byId.get(runId)
              return { _tag: "runs", items: found === undefined ? [] : [found] }
            }),
          watch: (filter) => filter.follow === true ? Stream.fromIterable(burst) : Stream.empty
        }),
        { heartbeatMillis: 60_000 }
      )

      const frames = yield* Stream.runCollect(
        projections.subscribe({ _tag: "workspace-runs" }).pipe(
          Stream.tap((frame) =>
            Effect.sync(() => {
              if (frame._tag === "snapshot-end") lookupsAtSnapshotEnd = runLookups
            })
          )
        )
      )
      const deltas = frames.filter((frame) => frame._tag === "delta")
      // A burst of a hundred events must not cost a hundred full-workspace
      // frames, and only the runs whose journals grew need their row re-read.
      expect(deltas).toHaveLength(1)
      const rows = deltas[0]?._tag === "delta" ? [...deltas[0].delta] : []
      expect(rows).toHaveLength(Projections.maxWorkspaceRuns)
      expect(rows.filter((row) => "turns" in row && row.turns === 20)).toHaveLength(changedRuns.length)
      expect(runLookups - lookupsAtSnapshotEnd).toBe(changedRuns.length)
    }))

  it.effect("appends transcript rows instead of re-sending the folded history", () =>
    Effect.gen(function*() {
      const history = Array.from({ length: 200 }, (_, index) =>
        index % 4 === 0
          ? event(index + 1, "control.agent.turn-opened", { runId: "run-1", seat: "opus" })
          : event(index + 1, "control.agent.model-settled", { runId: "run-1", text: "done", usage: {} }))
      const projections = make(
        control({
          list: () => Effect.succeed({ _tag: "runs", items: [run] }),
          watch: (filter) =>
            Stream.fromIterable(
              filter.follow === true ? history.filter((entry) => entry.sequence > (filter.afterSequence ?? 0)) : history
            )
        }),
        { heartbeatMillis: 60_000 }
      )
      const selector = { _tag: "transcript", runId: "run-1" } as const
      const after: GatewaySchema.ProjectionCursor = {
        selector,
        projection: "transcript",
        runId: "run-1",
        value: 50,
        offset: 0
      }

      const frames = yield* Stream.runCollect(projections.subscribe(selector, after))
      const deltas = frames.filter((frame) => frame._tag === "delta")
      expect(deltas).toHaveLength(150)
      // Each row is immutable once folded, so catching up on E events sends E
      // rows, not E squared, and the rows still fold to the same transcript.
      const sent = deltas.flatMap((frame) => frame._tag === "delta" ? [...frame.delta] : [])
      expect(sent).toHaveLength(150)
      expect(sent).toEqual(GatewayProjection.transcript(history).slice(50))
    }))
})
