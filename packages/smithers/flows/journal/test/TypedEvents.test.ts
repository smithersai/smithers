import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import * as EngineEvent from "../src/EngineEvent.ts"
import * as Journal from "../src/Journal.ts"
import * as Event from "../src/JournalEvent.ts"
import * as TestJournal from "../src/test/TestJournal.ts"

const scope: EngineEvent.Consumer = {
  runId: Event.RunId.make("run"),
  lineageId: Event.LineageId.make("lineage"),
  rootRunId: Event.RunId.make("run"),
  round: 0,
  parentRunId: null,
  sources: [Event.SourceId.make("engine")],
  unknown: "ignore"
}
const payload = {
  version: 2,
  lineage: { kind: "root", runId: "run", lineageId: "lineage", rootRunId: "run", round: 0, parentRunId: null },
  executionId: "run",
  stepKeyDigest: "dispatch",
  attempt: 1,
  lifecycle: { state: "running", startedAtMs: 10 }
}
const entry = (patch: Record<string, unknown> = {}) => ({
  runId: "run",
  seq: 0,
  sourceId: "engine",
  sourceSeq: 0,
  eventId: "fixture",
  emittedAtMs: 10,
  eventType: EngineEvent.attemptEventType,
  payload,
  meta: null,
  ...patch
})

describe("shared bounded primitives", () => {
  const identifiers = [
    Event.RunId,
    Event.LineageId,
    Event.WaitId,
    Event.CommandId,
    Event.PlanId,
    Event.DispatchId,
    Event.ArtifactId
  ]
  for (const schema of identifiers) {
    it(`preserves identifier bytes and enforces limits: ${schema.ast.annotations?.brand}`, () => {
      for (const length of [1, 1023, 1024]) {
        expect(Schema.decodeUnknownSync(schema)("x".repeat(length))).toHaveLength(length)
      }
      for (const value of ["", "x".repeat(1025), "a\u0000b", "\ud800", "\udc00", 1]) {
        expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow()
      }
      expect(Schema.decodeUnknownSync(schema)("a😀b")).toBe("a😀b")
    })
  }
  it("enforces non-negative and positive safe-integer budgets without defaults", () => {
    for (const schema of [Event.NonNegativeQuantity, Event.TimestampMs]) {
      for (const value of [0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
        expect(Schema.decodeUnknownSync(schema)(value)).toBe(value)
      }
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "0", null, undefined]) {
        expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow()
      }
    }
    for (const value of [1, 2, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
      expect(Event.PositiveQuantity.make(value)).toBe(value)
    }
    expect(() => Event.PositiveQuantity.make(0)).toThrow()
    expect(() => Event.PositiveQuantity.make(Number.MAX_SAFE_INTEGER + 1)).toThrow()
  })
  it.effect("offers explicit decoders and distinct branded constructors", () =>
    Effect.gen(function*() {
      for (
        const decode of [
          Event.decodeRunId,
          Event.decodeLineageId,
          Event.decodeWaitId,
          Event.decodeCommandId,
          Event.decodePlanId,
          Event.decodeDispatchId,
          Event.decodeArtifactId
        ]
      ) {
        expect(yield* decode("id")).toBe("id")
        const invalid: Effect.Effect<string, unknown> = decode("")
        expect((yield* Effect.exit(invalid))._tag).toBe("Failure")
      }
      expect(yield* Event.decodeTimestampMs(0)).toBe(0)
      expect(yield* Event.decodeNonNegativeQuantity(0)).toBe(0)
      expect(yield* Event.decodePositiveQuantity(1)).toBe(1)
      const plan: Event.PlanId = Event.PlanId.make("plan")
      // @ts-expect-error Plan and dispatch identities are different authorities.
      const dispatch: Event.DispatchId = plan
      // @ts-expect-error Dispatch and artifact identities are different authorities.
      const artifact: Event.ArtifactId = dispatch
      expect(artifact).toBe("plan")
    }))
})

describe("versioned engine event boundary", () => {
  it.effect("commits execution, deferred and clock variants with bounded semantic identities", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const events = [
        { _tag: "Execution", lifecycle: { state: "running", waits: [] } },
        {
          _tag: "Execution",
          lifecycle: {
            state: "suspended",
            waits: [{ _tag: "Deferred", waitId: "wait" }, { _tag: "Clock", waitId: "wait-clock", dueAtMs: 20 }]
          }
        },
        { _tag: "Execution", lifecycle: { state: "completed", result: { _tag: "Success", value: null } } },
        {
          _tag: "DeferredCompleted",
          waitId: "wait",
          result: { _tag: "Failure", reason: "encoding", detail: "unencodable" }
        },
        { _tag: "ClockScheduled", clockId: "clock", waitId: "wait-clock", dueAtMs: 20 }
      ]
      for (let index = 0; index < events.length; index++) {
        const expected = { version: 2, lineage: payload.lineage, executionId: "run", event: events[index] }
        const typed = Schema.decodeUnknownSync(EngineEvent.StatePayload)(expected)
        yield* journal.emitDurableUnfenced(
          EngineEvent.stateEvent(typed, scope.sources[0]!, Event.SourceSeq.make(index))
        )
        expect(EngineEvent.stateEvent(typed, scope.sources[0]!, Event.SourceSeq.make(index), { trace: "state" }).meta)
          .toEqual({ trace: "state" })
      }
      const rows = yield* journal.entries({ runId: scope.runId, limit: 10 })
      for (let index = 0; index < events.length; index++) {
        const decoded = yield* EngineEvent.decodeEntry(rows.entries[index], scope)
        expect(decoded).toMatchObject({ _tag: "State", payload: { event: events[index] } })
      }
      for (
        const event of [
          { _tag: "Execution", lifecycle: { state: "suspended", waits: [] } },
          { _tag: "Execution", lifecycle: { state: "running", waits: [], result: { _tag: "Success", value: null } } },
          { _tag: "Execution", lifecycle: { state: "completed" } },
          { _tag: "DeferredCompleted", waitId: "", result: { _tag: "Success", value: null } },
          { _tag: "ClockScheduled", clockId: "clock", waitId: "wait", dueAtMs: -1 },
          { _tag: "ClockScheduled", clockId: "", waitId: "wait", dueAtMs: 0 },
          { _tag: "Future" }
        ]
      ) {
        const error = yield* Effect.flip(EngineEvent.decodeEntry(
          entry({
            eventType: EngineEvent.stateEventType,
            payload: { version: 2, lineage: payload.lineage, executionId: "run", event }
          }),
          scope
        ))
        expect(error.code).toBe("malformed")
        expect(error.cause).toBeDefined()
      }
      expect(() =>
        Schema.decodeUnknownSync(EngineEvent.StatePayload)({
          version: 2,
          lineage: payload.lineage,
          executionId: "foreign",
          event: events[0]
        })
      ).toThrow()
    }).pipe(Effect.provide(TestJournal.layer())))

  it.effect("captures and decodes an actual committed SQLite journal row", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const typed = Schema.decodeUnknownSync(EngineEvent.AttemptPayload)(payload)
      yield* journal.emitDurableUnfenced(EngineEvent.attempt(typed, scope.sources[0]!, Event.SourceSeq.make(0)))
      const rows = yield* journal.entries({ runId: scope.runId, limit: 10 })
      const actual = rows.entries[0]!
      expect(JSON.parse(JSON.stringify(actual.payload))).toEqual(payload)
      const decoded = yield* EngineEvent.decodeEntry(actual, scope)
      expect(decoded._tag).toBe("Attempt")
      expect(actual.seq).toBe(0)
      expect(actual.meta).toBeNull()
      expect(EngineEvent.attempt(typed, scope.sources[0]!, Event.SourceSeq.make(1), { trace: "diagnostic" }).meta)
        .toEqual({ trace: "diagnostic" })
    }).pipe(Effect.provide(TestJournal.layer())))

  it.effect("makes unknown namespace behavior explicit and refuses unsupported known versions", () =>
    Effect.gen(function*() {
      const unknown = entry({ eventType: "vendor.custom" })
      expect(yield* EngineEvent.decodeEntry(unknown, scope)).toEqual({ _tag: "Ignored" })
      expect((yield* EngineEvent.decodeEntry(unknown, { ...scope, unknown: "surface" }))._tag).toBe("Unknown")
      const error = yield* Effect.flip(EngineEvent.decodeEntry(entry({ eventType: "flows.engine.v2.future" }), scope))
      expect(error.code).toBe("unsupported")
      expect(error.cause).toMatchObject({ eventType: "flows.engine.v2.future" })
      for (const eventType of ["flows.engine.v3.attempt-lifecycle", "flows.engine.attempt-started"]) {
        expect((yield* Effect.flip(EngineEvent.decodeEntry(entry({ eventType }), scope))).code).toBe("unsupported")
      }
    }))

  it.effect("refuses malformed known records and preserves schema and thrown causes", () =>
    Effect.gen(function*() {
      for (
        const changed of [
          { payload: { ...payload, version: 3 } },
          { payload: { ...payload, lineage: undefined } },
          { payload: { ...payload, attempt: -1 } },
          { payload: { ...payload, executionId: "foreign" } },
          { payload: { ...payload, stepKeyDigest: "" } },
          { seq: -1 },
          { sourceSeq: Number.MAX_SAFE_INTEGER },
          { emittedAtMs: -1 },
          { meta: new Error("not encoded") }
        ]
      ) {
        const error = yield* Effect.flip(EngineEvent.decodeEntry(entry(changed), scope))
        expect(error.code).toBe("malformed")
        expect(error.cause).toBeDefined()
      }
      const cause = new Error("getter failed")
      const error = yield* Effect.flip(EngineEvent.decodeEntry({
        get runId() {
          throw cause
        }
      }, scope))
      expect(error.cause).toBe(cause)
      const mutated = Object.assign(new Event.Entry(entry() as Event.Entry), { seq: -1 })
      expect((yield* Effect.flip(EngineEvent.decodeEntry(mutated, scope))).code).toBe("malformed")
    }))

  it.effect("refuses every foreign lineage coordinate and source", () =>
    Effect.gen(function*() {
      for (
        const consumer of [
          { ...scope, runId: Event.RunId.make("elsewhere") },
          { ...scope, sources: [] },
          { ...scope, lineageId: Event.LineageId.make("elsewhere") },
          { ...scope, rootRunId: Event.RunId.make("elsewhere") },
          { ...scope, round: 1 },
          { ...scope, parentRunId: Event.RunId.make("elsewhere") }
        ]
      ) {
        expect((yield* Effect.flip(EngineEvent.decodeEntry(entry(), consumer))).code).toBe("foreign")
      }
      const child = {
        ...payload,
        executionId: "child",
        lineage: {
          ...payload.lineage,
          kind: "child",
          runId: "child",
          parentRunId: "run"
        }
      }
      expect((yield* Effect.flip(EngineEvent.decodeEntry(entry({ payload: child }), scope))).code).toBe("foreign")
    }))

  it("requires a valid parent and root together and a positive continuation round", () => {
    const decode = Schema.decodeUnknownSync(EngineEvent.Lineage)
    const root = payload.lineage
    expect(decode(root)).toEqual(root)
    for (
      const invalid of [
        { ...root, rootRunId: "elsewhere" },
        { ...root, kind: "child", parentRunId: "run" },
        { ...root, kind: "fork", runId: "child", parentRunId: null },
        { ...root, kind: "continuation", runId: "child", parentRunId: "run" }
      ]
    ) expect(() => decode(invalid)).toThrow()
    for (const kind of ["child", "fork", "continuation"]) {
      expect(decode({ ...root, kind, runId: "child", parentRunId: "run", round: 1 }).kind).toBe(kind)
    }
  })

  it("accepts all lifecycle variants and rejects contradictory state", () => {
    const decode = Schema.decodeUnknownSync(EngineEvent.AttemptLifecycle, { onExcessProperty: "error" })
    const running = { state: "running", startedAtMs: 10 }
    for (const state of ["running", "suspended"]) {
      expect(decode({ ...running, state, checkpoint: null, heartbeatAtMs: 11 }).state).toBe(state)
    }
    const succeeded = { state: "succeeded", startedAtMs: 10, finishedAtMs: 5, result: { _tag: "Success", value: null } }
    expect(decode(succeeded)).toEqual(succeeded)
    for (const reason of ["error", "defect", "interrupted", "encoding"]) {
      expect(decode({ ...succeeded, state: "failed", result: { _tag: "Failure", reason, detail: {} } }).state).toBe(
        "failed"
      )
    }
    for (
      const value of [
        { ...running, finishedAtMs: 10 },
        { ...running, result: succeeded.result },
        { ...succeeded, result: undefined },
        { ...succeeded, finishedAtMs: undefined },
        { ...succeeded, state: "failed" },
        { ...succeeded, result: { _tag: "Success", value: new Error("class") } },
        { ...running, state: "custom" }
      ]
    ) expect(() => decode(value)).toThrow()
  })

  it.effect("decodes historical markers without inventing completion data", () =>
    Effect.gen(function*() {
      for (
        const [eventType, extra] of [
          ["flows.engine.attempt-started", { tier: "sealed" }],
          ["flows.engine.attempt-finished", { state: "succeeded" }]
        ] as const
      ) {
        const current = entry({
          eventType,
          payload: { runId: "run", stepKeyDigest: "dispatch", attempt: 1, ...extra },
          meta: { lineageId: "lineage" }
        })
        const decoded = yield* EngineEvent.decodeCurrentAttempt(current, scope)
        expect(decoded.marker.payload).toEqual(current.payload)
        expect(decoded.lineageId).toBe("lineage")
        for (
          const consumer of [
            { ...scope, runId: Event.RunId.make("foreign") },
            { ...scope, lineageId: Event.LineageId.make("foreign") },
            { ...scope, sources: [] }
          ]
        ) expect((yield* Effect.flip(EngineEvent.decodeCurrentAttempt(current, consumer))).code).toBe("foreign")
        const wrongRun = { ...current, payload: { ...current.payload, runId: "foreign" } }
        expect((yield* Effect.flip(EngineEvent.decodeCurrentAttempt(wrongRun, scope))).code).toBe("foreign")
        const missing = { ...current, payload: {} }
        const versioned = { ...current, payload: { ...current.payload, version: 2 } }
        expect((yield* Effect.flip(EngineEvent.decodeCurrentAttempt(versioned, scope))).code).toBe("malformed")
        const error = yield* Effect.flip(EngineEvent.decodeCurrentAttempt(missing, scope))
        expect(error.code).toBe("malformed")
        expect(error.cause).toBeDefined()
      }
    }))
})

describe("node and plan records", () => {
  // Copied from the shapes `PlanScheduler` emits today (PlanScheduler.ts:505,
  // :536, :1036, :1048, :966, :987). These schemas describe stored history, so
  // a change that stops decoding one of these is a migration, not a fix.
  const scheduled = {
    planId: "plan",
    nodeId: "compile",
    kind: "step",
    planKey: "key",
    dispatchKey: "dispatch",
    attempt: 1,
    priority: 0,
    waited: 12
  }
  const settled = {
    planId: "plan",
    nodeId: "compile",
    planKey: "key",
    dispatchKey: "dispatch",
    outcome: "built",
    attempts: 1,
    rebases: 0
  }
  const recorded = { planId: "plan", flow: "build", digest: "d", baseDigest: "b", generation: 0, nodes: 2 }
  const appended = { planId: "plan", digest: "d", baseDigest: "b", generation: 1, nodeIds: ["link"] }

  it("decodes what the plan scheduler writes today", () => {
    const strict = { onExcessProperty: "error" } as const
    expect(Schema.decodeUnknownSync(EngineEvent.NodeScheduledPayload, strict)(scheduled)).toEqual(scheduled)
    expect(Schema.decodeUnknownSync(EngineEvent.NodeSettledPayload, strict)(settled)).toEqual(settled)
    expect(Schema.decodeUnknownSync(EngineEvent.PlanRecordedPayload, strict)({ ...recorded, outcome: "Recorded" }))
      .toEqual({ ...recorded, outcome: "Recorded" })
    expect(Schema.decodeUnknownSync(EngineEvent.SubgraphAppendedPayload, strict)(appended)).toEqual(appended)
    expect(
      Schema.decodeUnknownSync(EngineEvent.NodeInvalidatedPayload, strict)({
        planId: "plan",
        nodeId: "compile",
        planKey: "key",
        from: "a",
        to: "b",
        reason: "measured-inputs-changed"
      }).reason
    ).toBe("measured-inputs-changed")
    expect(
      Schema.decodeUnknownSync(EngineEvent.NodeReconciledPayload, strict)({
        planId: "plan",
        nodeId: "compile",
        trigger: "deviation",
        verdict: { _tag: "Accept" }
      }).nodeId
    ).toBe("compile")
  })

  it("decodes what an interpreter writes, which knows no plan id and no dispatch key", () => {
    const decode = Schema.decodeUnknownSync(EngineEvent.PlanRecordedPayload, { onExcessProperty: "error" })
    const graph = {
      nodes: [{
        id: "read",
        kind: "ActionCall",
        dependsOn: [],
        tier: "sealed",
        action: "fs/read",
        declaredAt: { path: "src/Build.ts", line: 12 }
      }],
      edges: [{ from: "read", to: "double", reason: "value" }]
    }
    const interpreted = { flow: "build", generation: 0, nodes: 1, page: 0, pages: 1, graph }
    expect(decode(interpreted)).toEqual(interpreted)
    expect(
      Schema.decodeUnknownSync(EngineEvent.NodeScheduledPayload, { onExcessProperty: "error" })({
        nodeId: "read",
        kind: "ActionCall",
        attempt: 1
      }).planId
    ).toBeUndefined()
    for (const outcome of ["built", "clean", "failed", "skipped", "deferred"]) {
      expect(
        Schema.decodeUnknownSync(EngineEvent.NodeSettledPayload)({ nodeId: "read", outcome, attempts: 0 }).outcome
      ).toBe(outcome)
    }
    expect(() =>
      Schema.decodeUnknownSync(EngineEvent.NodeSettledPayload)({ nodeId: "read", outcome: "cached", attempts: 0 })
    )
      .toThrow()
  })

  /*
   * D-068: a recorded site says where a node was declared and never which
   * bytes were there. A writer that knows the revision its sources were read
   * at states it on the page those sites ride on; one that does not says
   * nothing, and a reader with nothing opens no code at all.
   */
  it("carries the revision the recorded sites were read at, when the writer knew one", () => {
    const decode = Schema.decodeUnknownSync(EngineEvent.PlanRecordedPayload, { onExcessProperty: "error" })
    const graph = {
      nodes: [{
        id: "read",
        kind: "ActionCall",
        dependsOn: [],
        tier: "sealed",
        declaredAt: { path: "src/Build.ts", line: 12 }
      }],
      edges: [],
      sourceRevision: "b".repeat(40)
    }
    const page = { flow: "build", generation: 0, nodes: 1, page: 0, pages: 1, graph }
    expect(decode(page).graph?.sourceRevision).toBe("b".repeat(40))
    const { sourceRevision: _named, ...unnamed } = graph
    expect(decode({ ...page, graph: unnamed }).graph?.sourceRevision).toBeUndefined()
    /*
     * Only the forty lowercase hex digits the producer emits. A reader puts
     * this value into a contents route's `?ref=` and that route spawns jj or
     * git from it, so a branch name, an abbreviation, an upper-case id, a
     * leading `-` that git reads as an option, and the empty string are all
     * refused here rather than downstream.
     */
    for (
      const invalid of [
        "",
        "main",
        "b".repeat(39),
        "b".repeat(41),
        "B".repeat(40),
        `-${"b".repeat(39)}`,
        `${"b".repeat(40)}\n`
      ]
    ) {
      expect(() => decode({ ...page, graph: { ...graph, sourceRevision: invalid } })).toThrow()
    }
    expect(
      Schema.decodeUnknownSync(EngineEvent.SubgraphAppendedPayload, { onExcessProperty: "error" })({
        flow: "build",
        generation: 0,
        nodeIds: ["read"],
        graph
      }).graph?.sourceRevision
    ).toBe("b".repeat(40))
  })

  it("refuses a declaration path that would publish the machine it was written on", () => {
    const decode = Schema.decodeUnknownSync(EngineEvent.DeclaredAt)
    expect(decode({ path: "packages/build/src/Build.ts", line: 12 })).toEqual({
      path: "packages/build/src/Build.ts",
      line: 12
    })
    expect(decode({ path: "src/Build.ts", line: 0 }).line).toBe(0)
    for (
      const invalid of [
        { path: "/Users/someone/repo/src/Build.ts", line: 12 },
        { path: "", line: 12 },
        { path: "src/Build.ts", line: -1 }
      ]
    ) expect(() => decode(invalid)).toThrow()
  })

  it("strips the root off a declaration path, and answers nothing where it cannot", () => {
    // The writer's one job beside the schema above: obey the refusal of an
    // absolute path by stripping the root, and say nothing rather than
    // record a path the refusal would reject or a reader could not resolve.
    expect(EngineEvent.relativePath("/repo", "/repo/src/Build.ts")).toBe("src/Build.ts")
    // A trailing slash on the root is the same root.
    expect(EngineEvent.relativePath("/repo/", "/repo/src/Build.ts")).toBe("src/Build.ts")

    // A host that declares no root strips nothing, so it records nothing.
    expect(EngineEvent.relativePath(undefined, "/repo/src/Build.ts")).toBeUndefined()
    // A root that IS the filesystem strips one leading slash and leaves an
    // operator's home directory in a run's permanent history, so it is read
    // as no root at all. The empty string and a Windows drive root say the
    // same thing.
    for (const root of ["", "/", "C:", "C:\\", "c:/"]) {
      expect(EngineEvent.relativePath(root, "/repo/src/Build.ts")).toBeUndefined()
    }
    // Nothing to place.
    expect(EngineEvent.relativePath("/repo", "")).toBeUndefined()
    // Outside the root: omitted rather than recorded with `..` segments, which
    // only a reader who knew the root could resolve.
    expect(EngineEvent.relativePath("/repo", "/elsewhere/src/Build.ts")).toBeUndefined()
    // A sibling whose name merely starts with the root's is outside it.
    expect(EngineEvent.relativePath("/repo", "/repository/src/Build.ts")).toBeUndefined()
    // The root itself is not a file under it.
    expect(EngineEvent.relativePath("/repo", "/repo/")).toBeUndefined()
  })

  it("names one event type per record, and does not rename a stored one", () => {
    expect(EngineEvent.nodeEventTypes).toEqual({
      planRecorded: "flows.engine.plan-recorded",
      subgraphAppended: "flows.engine.subgraph-appended",
      nodeScheduled: "flows.engine.node-scheduled",
      nodeSettled: "flows.engine.node-settled",
      nodeInvalidated: "flows.engine.node-invalidated",
      nodeReconciled: "flows.engine.node-reconciled"
    })
  })
})
