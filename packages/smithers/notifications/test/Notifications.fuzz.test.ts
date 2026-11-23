import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Arbitrary, Duration, Effect, Layer, Logger, Option, Redacted, Result, Schema } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import {
  Alerts,
  Channels,
  Inbox,
  Notification,
  NotificationEvent,
  NotificationQueue,
  NotificationState,
  Projection,
  SteerPayload
} from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "150"))
const dbExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "100" : "25"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLayer = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const makeNotif = (
  id: string,
  kind: "steer" | "followup" | "system",
  targetLineageId: string,
  body: string,
  coalescingKey?: string
): Notification.Notification => {
  const provenance: Notification.Provenance = {
    sourceRunId: "op",
    sourceLineageId: "op/root",
    sourceTurn: 1,
    sourceActor: "person:will"
  }
  if (kind === "steer") {
    return Notification.humanSteer({
      runId: targetLineageId,
      id,
      actor: "person:will",
      payload: SteerPayload.encode({ kind: "Message", body }),
      attribution: { via: "cli" }
    })
  }
  if (kind === "followup") {
    return {
      _tag: "human-followup",
      id,
      delivery: "queue",
      targetLineageId,
      provenance,
      payload: { body }
    }
  }
  return {
    _tag: "system-event",
    id,
    delivery: "queue",
    targetLineageId,
    provenance,
    payload: { body },
    ...(coalescingKey === undefined ? {} : { coalescingKey })
  }
}

describe("@smthrs/notifications Inbox, SteerPayload & NotificationEvent fuzz invariants", () => {
  it("Inbox.route, audience, raises & ack satisfy deduplication, precedence & monotonicity laws", async () => {
    const userArb = Schema.Literals(["ana", "ben", "cora", "dan"])
    const levelArb = Schema.Literals(["all", "attention", "muted"])
    const stateArb = Schema.Literals(["working", "waiting", "needs_you", "failed", "done"])
    const arb = Arbitrary.schema(
      Schema.Struct({
        launcher: Schema.OptionFromUndefinedOr(userArb),
        state: stateArb,
        prevState: Schema.OptionFromUndefinedOr(stateArb),
        watchers: Schema.Array(Schema.Struct({ principal: userArb, level: levelArb })).pipe(
          Schema.check(Schema.isMaxLength(10))
        ),
        blockedUser: Schema.OptionFromUndefinedOr(userArb),
        version: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 15 }))),
        ops: Schema.Array(
          Schema.Struct({
            act: Schema.Literals(["read", "dismiss", "hide"]),
            v: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 })))
          })
        ).pipe(Schema.check(Schema.isMaxLength(8)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ launcher, state, prevState, watchers, blockedUser, version, ops }) =>
          Effect.sync(() => {
            const launcherId = launcher._tag === "Some" ? launcher.value : undefined
            const blockedId = blockedUser._tag === "Some" ? blockedUser.value : undefined
            const mayRead = (p: string) => p !== blockedId
            const deliveries = Inbox.route({ launcher: launcherId, state, watchers, mayRead })
            const recipients = deliveries.map((d) => d.recipient)
            if (new Set(recipients).size !== recipients.length) return false
            if (blockedId !== undefined && recipients.includes(blockedId)) return false
            if (launcherId !== undefined && mayRead(launcherId)) {
              const first = deliveries[0]
              if (
                first === undefined || first.recipient !== launcherId || !first.mine || first.quiet ||
                first.state !== state
              ) return false
            }
            const firstLevel = new Map<string, Inbox.Level>()
            for (const w of watchers) if (!firstLevel.has(w.principal)) firstLevel.set(w.principal, w.level)
            for (const d of deliveries) {
              if (d.recipient === launcherId) continue
              if (d.mine || d.state === "needs_you") return false
              const lvl = firstLevel.get(d.recipient)
              if (lvl === undefined || lvl === "muted" || d.quiet !== (lvl === "attention")) return false
            }

            // audience matches non-muted permitted watchers in order
            const aud = Inbox.audience(watchers, mayRead)
            if (new Set(aud).size !== aud.length) return false
            if (blockedId !== undefined && aud.includes(blockedId)) return false
            // Default mayRead (everyone)
            const audAll = Inbox.audience(watchers)
            if (audAll.length < aud.length) return false

            // raises law
            const prev = prevState._tag === "Some" ? prevState.value : undefined
            const expectedRaise = prev === undefined ||
              (state !== prev && (state === "needs_you" || state === "failed" || state === "done"))
            if (Inbox.raises(prev, state) !== expectedRaise) return false

            // ack monotonicity & NaN rejection
            let vs: Inbox.Versions = { version, readVersion: 0, dismissedVersion: 0, hiddenVersion: 0 }
            if (Inbox.ack(vs, "read", Number.NaN) !== vs) return false
            for (const op of ops) {
              const next = Inbox.ack(vs, op.act, op.v)
              if (
                next.readVersion < vs.readVersion ||
                next.dismissedVersion < vs.dismissedVersion ||
                next.hiddenVersion < vs.hiddenVersion
              ) return false
              vs = next
              if (Inbox.isUnread(vs) !== (vs.readVersion < vs.version)) return false
              if (Inbox.isOpen(vs) !== (vs.dismissedVersion < vs.version)) return false
              if (Inbox.isHidden(vs) !== (vs.hiddenVersion >= vs.version)) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("SteerPayload.encode/decode round-trips human steers and NEVER decodes system-events, and NotificationEvent stays total", async () => {
    const steerArb = Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("Message"),
        body: Schema.String.pipe(Schema.check(Schema.isMaxLength(30)))
      }),
      Schema.Struct({ kind: Schema.Literal("Seat"), seat: Schema.Literals(["fast", "pro", "opus"]) }),
      Schema.Struct({ kind: Schema.Literal("Thinking"), thinking: SteerPayload.Thinking }),
      Schema.Struct({
        kind: Schema.Literal("Tools"),
        toolNames: Schema.NonEmptyArray(Schema.Literals(["read", "write", "bash"]))
      })
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        steer: steerArb,
        lineage: Schema.Literals(["run/1", "a/b", "lin-x"]),
        boundary: Schema.Literals(["turn-1", "a/b", "idle"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ steer, lineage, boundary }) =>
          Effect.sync(() => {
            const encoded = SteerPayload.encode(steer)
            const human = Notification.humanSteer({ runId: lineage, id: "n1", actor: "person:a", payload: encoded })
            const decoded = SteerPayload.decode(human)
            if (JSON.stringify(decoded) !== JSON.stringify(steer)) return false

            // system-event NEVER decodes as a steer
            const sys: Notification.Notification = {
              _tag: "system-event",
              id: "s1",
              delivery: "queue",
              targetLineageId: lineage,
              provenance: human.provenance,
              payload: encoded,
              coalescingKey: "ck"
            }
            if (SteerPayload.decode(sys) !== undefined) return false
            if (Notification.coalesceKey(sys) !== "ck" || Notification.coalesceKey(human) !== null) return false

            // Body-only shorthand on human-followup decodes to Message
            const shorthand = makeNotif("f1", "followup", lineage, "hi")
            const decShort = SteerPayload.decode(shorthand)
            if (decShort?.kind !== "Message" || decShort.body !== "hi") return false

            // Non-object payload decodes to undefined
            const badHuman = Notification.humanSteer({ runId: lineage, id: "n2", actor: "person:a", payload: "raw" })
            if (SteerPayload.decode(badHuman) !== undefined) return false

            // NotificationEvent source ids & fromEntry
            const admSrc = NotificationEvent.admissionSource("n1")
            const drnSrc = NotificationEvent.drainSource(lineage, boundary)
            if (Option.isNone(admSrc) || Option.isNone(drnSrc)) return false
            if (NotificationEvent.admissionSourceId("n1") !== admSrc.value) return false
            if (NotificationEvent.drainSourceId(lineage, boundary) !== drnSrc.value) return false
            // Lone surrogate returns None
            if (Option.isSome(NotificationEvent.drainSource("\ud800", boundary))) return false

            const admEntry = new JournalEvent.Entry({
              runId: JournalEvent.RunId.make("r1"),
              seq: JournalEvent.Seq.make(1),
              eventId: "e1",
              sourceId: admSrc.value,
              sourceSeq: JournalEvent.SourceSeq.make(1),
              emittedAtMs: 100,
              eventType: NotificationEvent.AdmittedEventType,
              payload: { notification: human, decision: "admitted" },
              meta: {}
            })
            const decAdm = NotificationEvent.fromEntry(admEntry)
            if (Option.isNone(decAdm) || !NotificationEvent.isAdmitted(decAdm.value)) return false

            const promEntry = new JournalEvent.Entry({
              runId: JournalEvent.RunId.make("r1"),
              seq: JournalEvent.Seq.make(2),
              eventId: "e2",
              sourceId: drnSrc.value,
              sourceSeq: JournalEvent.SourceSeq.make(1),
              emittedAtMs: 101,
              eventType: NotificationEvent.PromotedEventType,
              payload: { boundary, targetLineageId: lineage, ids: ["n1"] },
              meta: {}
            })
            const decProm = NotificationEvent.fromEntry(promEntry)
            if (Option.isNone(decProm) || !NotificationEvent.isPromoted(decProm.value)) return false

            // Foreign event type returns None
            const foreign = new JournalEvent.Entry({
              ...admEntry,
              eventType: "other.event"
            })
            return Option.isNone(NotificationEvent.fromEntry(foreign))
          }),
        { seed: seed + 1, executions }
      )
    )
    assertPassed(report)
  })
})

describe("@smthrs/notifications NotificationState, Projection & NotificationQueue fuzz invariants", () => {
  it("NotificationState transitions & Projection.derive preserve capacity, lineage coalescing & FIFO promotion order", async () => {
    const opArb = Schema.Union([
      Schema.Struct({
        op: Schema.Literal("admit"),
        kind: Schema.Literals(["steer", "followup", "system"]),
        lineage: Schema.Literals(["L1", "L2"]),
        ck: Schema.OptionFromUndefinedOr(Schema.Literals(["k1", "k2"]))
      }),
      Schema.Struct({
        op: Schema.Literal("promoteSteers"),
        lineage: Schema.Literals(["L1", "L2"]),
        cutoffDelta: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -2, maximum: 2 })))
      }),
      Schema.Struct({
        op: Schema.Literal("promoteQueued"),
        lineage: Schema.Literals(["L1", "L2"])
      }),
      Schema.Struct({
        op: Schema.Literal("promoteIds"),
        lineage: Schema.Literals(["L1", "L2"])
      })
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        capacity: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
        ops: Schema.Array(opArb).pipe(Schema.check(Schema.isMaxLength(16)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ capacity, ops }) =>
          Effect.gen(function*() {
            let state = NotificationState.empty(capacity)
            let seq = 0
            const entries: Array<JournalEvent.Entry> = []
            let eventIdx = 0

            for (const op of ops) {
              seq++
              if (op.op === "admit") {
                const id = `n-${seq}`
                const ck = op.ck._tag === "Some" ? op.ck.value : undefined
                const notif = makeNotif(id, op.kind, op.lineage, `b-${seq}`, ck)
                const adm = NotificationState.admit(state, notif, seq)
                if (adm.state.items.length > capacity) return false
                const replayed = NotificationState.applyAdmission(state, notif, seq, adm.decision)
                if (replayed.items.length !== adm.state.items.length) return false
                state = adm.state
                if (adm.decision !== "rejected-full") {
                  entries.push(
                    new JournalEvent.Entry({
                      runId: JournalEvent.RunId.make("r1"),
                      seq: JournalEvent.Seq.make(++eventIdx),
                      eventId: `ev-${eventIdx}`,
                      sourceId: NotificationEvent.admissionSourceId(id),
                      sourceSeq: JournalEvent.SourceSeq.make(1),
                      emittedAtMs: eventIdx * 10,
                      eventType: NotificationEvent.AdmittedEventType,
                      payload: { notification: notif, decision: adm.decision },
                      meta: {}
                    })
                  )
                }
              } else if (op.op === "promoteSteers") {
                const prom = NotificationState.promoteSteers(state, Math.max(0, seq + op.cutoffDelta), op.lineage)
                const after = NotificationState.applyPromoted(state, prom.promoted.map((p) => p.notification.id))
                if (after.items.length !== prom.state.items.length) return false
                state = prom.state
                if (prom.promoted.length > 0) {
                  entries.push(
                    new JournalEvent.Entry({
                      runId: JournalEvent.RunId.make("r1"),
                      seq: JournalEvent.Seq.make(++eventIdx),
                      eventId: `ev-${eventIdx}`,
                      sourceId: NotificationEvent.drainSourceId(op.lineage, `b-${eventIdx}`),
                      sourceSeq: JournalEvent.SourceSeq.make(1),
                      emittedAtMs: eventIdx * 10,
                      eventType: NotificationEvent.PromotedEventType,
                      payload: {
                        boundary: `b-${eventIdx}`,
                        targetLineageId: op.lineage,
                        ids: prom.promoted.map((p) => p.notification.id)
                      },
                      meta: {}
                    })
                  )
                }
              } else if (op.op === "promoteQueued") {
                const beforeQ = NotificationState.pending(state, "queue", op.lineage)
                const prom = NotificationState.promoteQueued(state, op.lineage)
                if (beforeQ.length === 0 && prom.promoted.length !== 0) return false
                if (
                  beforeQ.length > 0 &&
                  (prom.promoted.length !== 1 || prom.promoted[0]!.notification.id !== beforeQ[0]!.notification.id)
                ) {
                  return false
                }
                state = prom.state
                if (prom.promoted.length > 0) {
                  entries.push(
                    new JournalEvent.Entry({
                      runId: JournalEvent.RunId.make("r1"),
                      seq: JournalEvent.Seq.make(++eventIdx),
                      eventId: `ev-${eventIdx}`,
                      sourceId: NotificationEvent.drainSourceId(op.lineage, `b-${eventIdx}`),
                      sourceSeq: JournalEvent.SourceSeq.make(1),
                      emittedAtMs: eventIdx * 10,
                      eventType: NotificationEvent.PromotedEventType,
                      payload: {
                        boundary: `b-${eventIdx}`,
                        targetLineageId: op.lineage,
                        ids: prom.promoted.map((p) => p.notification.id)
                      },
                      meta: {}
                    })
                  )
                }
              } else {
                const steers = NotificationState.pending(state, "steer", op.lineage)
                const targetIds = steers.length > 0 ? [steers[0]!.notification.id] : ["ghost"]
                const prom = NotificationState.promoteIds(state, targetIds, op.lineage)
                state = prom.state
                if (prom.promoted.length > 0) {
                  entries.push(
                    new JournalEvent.Entry({
                      runId: JournalEvent.RunId.make("r1"),
                      seq: JournalEvent.Seq.make(++eventIdx),
                      eventId: `ev-${eventIdx}`,
                      sourceId: NotificationEvent.drainSourceId(op.lineage, `b-${eventIdx}`),
                      sourceSeq: JournalEvent.SourceSeq.make(1),
                      emittedAtMs: eventIdx * 10,
                      eventType: NotificationEvent.PromotedEventType,
                      payload: {
                        boundary: `b-${eventIdx}`,
                        targetLineageId: op.lineage,
                        ids: prom.promoted.map((p) => p.notification.id)
                      },
                      meta: {}
                    })
                  )
                }
              }
            }

            // Projection.derive agrees with NotificationState!
            let projected = Projection.derive.initial
            for (const e of entries) {
              projected = yield* Projection.derive.reduce(projected, e)
            }
            if (projected.items.length !== state.items.length) return false
            for (let i = 0; i < state.items.length; i++) {
              if (projected.items[i]!.notification.id !== state.items[i]!.notification.id) return false
            }
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)

    // Edge cases: NaN capacity -> 0, applyAdmission coalesced on missing key, applyPromoted empty
    expect(NotificationState.empty(Number.NaN).capacity).toBe(0)
    const s0 = NotificationState.empty(4)
    const sys = makeNotif("c1", "system", "L1", "b", "k")
    expect(NotificationState.applyAdmission(s0, sys, 1, "coalesced").items.length).toBe(1)
    expect(NotificationState.applyPromoted(s0, [])).toBe(s0)
  })

  it("NotificationQueue over real SQLite enforces idempotency, edits, coalescing, capacity & replayable drains", async () => {
    const opArb = Schema.Union([
      Schema.Struct({
        op: Schema.Literal("admit"),
        id: Schema.Literals(["n1", "n2", "n3", "n4", "n5"]),
        kind: Schema.Literals(["steer", "followup", "system"]),
        lineage: Schema.Literals(["L1", "L2"]),
        ck: Schema.OptionFromUndefinedOr(Schema.Literals(["ck1", "ck2"])),
        body: Schema.Literals(["v1", "v2"])
      }),
      Schema.Struct({
        op: Schema.Literal("drain"),
        lineage: Schema.Literals(["L1", "L2"]),
        boundary: Schema.Literals(["b1", "b2", "b3"]),
        wouldIdle: Schema.Boolean,
        useIds: Schema.Boolean
      })
    ])
    const arb = Arbitrary.schema(
      Schema.Array(opArb).pipe(Schema.check(Schema.isMinLength(2), Schema.isMaxLength(12)))
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) => {
          const queueLayer = NotificationQueue.layerWith({ capacity: 3 }).pipe(
            Layer.provideMerge(TestJournal.layer()),
            Layer.provideMerge(silentLayer)
          )
          return Effect.gen(function*() {
            const queue = yield* NotificationQueue.NotificationQueue
            const admittedMap = new Map<string, Notification.Notification>()
            const drainedBoundaries = new Map<string, ReadonlyArray<string>>()

            for (const op of ops) {
              if (op.op === "admit") {
                const ck = op.ck._tag === "Some" ? op.ck.value : undefined
                const notif = makeNotif(op.id, op.kind, op.lineage, op.body, ck)
                const res = yield* Effect.result(queue.admit("run-fuzz", notif))
                const prev = admittedMap.get(op.id)
                if (prev !== undefined) {
                  if (JSON.stringify(prev) === JSON.stringify(notif)) {
                    if (Result.isFailure(res) || !res.success.duplicate) return false
                  } else {
                    // Conflicting content for same id MUST fail with notification_conflict
                    if (Result.isSuccess(res) || res.failure._tag !== "/notifications/NotificationError") return false
                  }
                } else if (Result.isSuccess(res) && res.success.decision !== "rejected-full") {
                  admittedMap.set(op.id, notif)
                }
              } else {
                const pend = yield* queue.pending("run-fuzz")
                const key = `${op.lineage}:${op.boundary}`
                const ids = op.useIds
                  ? pend.filter((n) => n._tag === "human-steer" && n.targetLineageId === op.lineage).slice(0, 1).map((
                    n
                  ) => n.id)
                  : undefined
                const drainInput: NotificationQueue.DrainInput = {
                  runId: "run-fuzz",
                  targetLineageId: op.lineage,
                  boundary: op.boundary,
                  wouldIdle: op.wouldIdle,
                  ...(ids !== undefined && ids.length > 0 ? { ids } : {})
                }
                const receipt = yield* queue.drain(drainInput)
                const prevDrain = drainedBoundaries.get(key)
                if (prevDrain !== undefined) {
                  if (!receipt.duplicate) return false
                  if (JSON.stringify(receipt.notifications.map((n) => n.id)) !== JSON.stringify(prevDrain)) return false
                } else {
                  if (receipt.duplicate) return false
                  drainedBoundaries.set(key, receipt.notifications.map((n) => n.id))
                }
              }
            }
            return true
          }).pipe(Effect.provide(queueLayer))
        },
        { seed: seed + 3, executions: dbExecutions }
      )
    )
    assertPassed(report)

    // Cover versioned steer edits, cutoffSeq, error paths & makeNoop/layerNoop
    const fullLayer = NotificationQueue.layer.pipe(
      Layer.provideMerge(TestJournal.layer()),
      Layer.provideMerge(silentLayer)
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        const s1 = makeNotif("ed-1", "steer", "L1", "first draft")
        const r1 = yield* queue.admit("run-edit", s1, 1)
        expect(r1.decision).toBe("admitted")
        // Version 2 edits payload in place
        const s2 = makeNotif("ed-1", "steer", "L1", "edited draft")
        const r2 = yield* queue.admit("run-edit", s2, 2)
        expect(r2.duplicate).toBe(false)
        const pend = yield* queue.pending("run-edit")
        expect(pend.length).toBe(1)
        expect((pend[0]!.payload as { body: string }).body).toBe("edited draft")

        // Admit a second steer at seq > 0, then drain with cutoffSeq 0: holds the second steer
        const s3 = makeNotif("ed-2", "steer", "L1", "later steer")
        yield* queue.admit("run-edit", s3)
        const held = yield* queue.drain({
          runId: "run-edit",
          targetLineageId: "L1",
          boundary: "early",
          wouldIdle: false,
          cutoffSeq: 0
        })
        expect(held.notifications.map((n) => n.id)).toEqual(["ed-1"])

        // Drain without cutoff delivers remaining steer
        const delivered = yield* queue.drain({
          runId: "run-edit",
          targetLineageId: "L1",
          boundary: "late",
          wouldIdle: false
        })
        expect(delivered.notifications.map((n) => n.id)).toEqual(["ed-2"])

        // Invalid inputs
        expect(Result.isFailure(yield* Effect.result(queue.admit("", s1)))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(queue.pending("")))).toBe(true)
        expect(
          Result.isFailure(
            yield* Effect.result(
              queue.drain({
                runId: "run-edit",
                targetLineageId: "L1",
                boundary: "bad",
                wouldIdle: false,
                cutoffSeq: -1
              })
            )
          )
        ).toBe(true)
        // Deeply nested payload > 256 levels rejected
        let deep: unknown = "leaf"
        for (let i = 0; i < 270; i++) deep = { a: deep }
        expect(
          Result.isFailure(
            yield* Effect.result(
              queue.admit("run-edit", { ...s1, id: "deep-1", payload: deep as typeof Schema.Json.Type })
            )
          )
        ).toBe(true)

        // Noop service
        const noop = NotificationQueue.makeNoop()
        expect(Result.isFailure(yield* Effect.result(noop.admit("r", s1)))).toBe(true)
        expect(
          Result.isFailure(
            yield* Effect.result(noop.drain({ runId: "r", targetLineageId: "L1", boundary: "b", wouldIdle: false }))
          )
        ).toBe(true)
        expect(Result.isFailure(yield* Effect.result(noop.pending("r")))).toBe(true)
        const noopFromLayer = yield* NotificationQueue.NotificationQueue.pipe(
          Effect.provide(NotificationQueue.layerNoop())
        )
        expect(Result.isFailure(yield* Effect.result(noopFromLayer.pending("r")))).toBe(true)
      }).pipe(Effect.provide(fullLayer))
    )
  })
})

describe("@smthrs/notifications Alerts, AlertProbe, Channels & Webhook fuzz invariants", () => {
  it("AlertPolicy.conditions & decide match exact open/close/delay/repeat semantics across random journals", async () => {
    const policy: Alerts.Policy = {
      defaults: { severity: "warning", owner: "oncall", runbook: "https://rb/default" },
      rules: {
        "waiting-approval": { afterMs: 100, repeatMs: 50 },
        stalled: { afterMs: 50, severity: "critical" },
        ...Alerts.probes({ "site*lag": { afterMs: 20 } }).rules
      },
      detectors: Alerts.probes({ "site*lag": { afterMs: 20 } }).detectors
    }
    const evArb = Schema.Struct({
      dt: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
      kind: Schema.Literals(["wait", "resume", "stall", "healthy", "probeFail", "probeOk", "alertDelivered", "other"])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        events: Schema.Array(evArb).pipe(Schema.check(Schema.isMaxLength(12))),
        nowDelta: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 250 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ events, nowDelta }) =>
          Effect.sync(() => {
            let t = 1_000
            const entries: Array<JournalEvent.Entry> = []
            let openWait: number | undefined
            let openStall: number | undefined
            let openProbe: number | undefined

            for (const [idx, ev] of events.entries()) {
              t += ev.dt
              let eventType = "other.ev"
              let payload: Record<string, unknown> = { x: 1 }
              if (ev.kind === "wait") {
                eventType = "control.run.parked"
                payload = { status: "waiting-approval" }
                openWait ??= t
              } else if (ev.kind === "resume") {
                eventType = "control.run.resume"
                payload = { status: "running" }
                openWait = undefined
              } else if (ev.kind === "stall") {
                eventType = "control.monitor.beat"
                payload = { health: "stalled" }
                openStall ??= t
              } else if (ev.kind === "healthy") {
                eventType = "control.monitor.beat"
                payload = { health: "healthy" }
                openStall = undefined
              } else if (ev.kind === "probeFail") {
                eventType = Alerts.probeEventType("site*lag")
                payload = { state: "failing", summary: "lagging 5m" }
                openProbe ??= t
              } else if (ev.kind === "probeOk") {
                eventType = Alerts.probeEventType("site*lag")
                payload = { state: "ok" }
                openProbe = undefined
              } else if (ev.kind === "alertDelivered") {
                eventType = Alerts.deliveredEventType
                payload = { status: "503", alertId: "x" }
              }
              entries.push(
                new JournalEvent.Entry({
                  runId: JournalEvent.RunId.make("r1"),
                  seq: JournalEvent.Seq.make(idx + 1),
                  eventId: `e-${idx}`,
                  sourceId: JournalEvent.SourceId.make("/test"),
                  sourceSeq: JournalEvent.SourceSeq.make(idx + 1),
                  emittedAtMs: t,
                  eventType,
                  payload,
                  meta: {}
                })
              )
            }

            const open = Alerts.conditions(policy, "r1", entries)
            const findSince = (c: string) => open.find((o) => o.condition === c)?.since
            if (findSince("waiting-approval") !== openWait) return false
            if (findSince("stalled") !== openStall) return false
            if (findSince("site*lag") !== openProbe) return false

            const now = t + nowDelta
            const alerts = Alerts.decide(policy, open, now)
            for (const a of alerts) {
              const rule = policy.rules[a.condition]!
              if (now - a.since < rule.afterMs) return false
              if (Alerts.alertId(a).length === 0) return false
              const msg = Alerts.messageOf(a)
              if (!msg.subject.includes(a.severity) || !msg.text.includes(a.runId)) return false
            }
            return true
          }),
        { seed: seed + 4, executions }
      )
    )
    assertPassed(report)

    // messageOf truncation & long alertId digest
    const longAlert: Alerts.Alert = {
      runId: "r".repeat(200),
      condition: "c".repeat(200),
      since: 1_000,
      firedAt: 2_000,
      reminder: 2,
      severity: "critical",
      coalescingKey: "k".repeat(300),
      summary: "sum",
      owner: "o".repeat(200),
      runbook: "u".repeat(200)
    }
    const longMsg = Alerts.messageOf(longAlert)
    expect(longMsg.id.startsWith("alert:")).toBe(true)
    expect(longMsg.subject).toContain("(reminder 2)")
  })

  it("AlertRuntime tick/standing/acknowledge/probe, Channels & layerWebhook handle delivery, retries, acks & HTTP statuses", async () => {
    const policy: Alerts.Policy = {
      defaults: { severity: "warning", owner: "oncall" },
      rules: {
        "waiting-approval": { afterMs: 100, repeatMs: 100 },
        ...Alerts.probes({ disk: { afterMs: 0, severity: "critical" } }).rules
      },
      detectors: Alerts.probes({ disk: { afterMs: 0, severity: "critical" } }).detectors
    }

    // 1. AlertRuntime full lifecycle over TestJournal + TestClock
    const testLayer = (sink: Layer.Layer<Alerts.Sink>, capacity = 128) => {
      const journalLayer = TestJournal.layer()
      const queueLayer = NotificationQueue.layerWith({ capacity }).pipe(Layer.provide(journalLayer))
      const runtimeLayer = Alerts.layer(policy).pipe(
        Layer.provide(Layer.mergeAll(journalLayer, queueLayer, sink))
      )
      return Layer.mergeAll(journalLayer, queueLayer, runtimeLayer, TestClock.layer(), silentLayer)
    }

    await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const runtime = yield* Alerts.AlertRuntime

        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make("run-a"),
            sourceId: JournalEvent.SourceId.make("/ctrl"),
            eventType: "control.run.parked",
            payload: { status: "waiting-approval" }
          })
        )
        yield* Alerts.report({ runId: "run-a", probe: "disk", state: "failing", summary: "98% full" })

        // Immediate tick: disk fires (afterMs: 0), waiting-approval waits
        const t1 = yield* runtime.tick("run-a")
        expect(t1.delivered.map((a) => a.condition)).toEqual(["disk"])

        // Advance clock by 150ms -> waiting-approval fires, disk suppressed
        yield* TestClock.adjust("150 millis")
        const t2 = yield* runtime.tick("run-a")
        expect(t2.delivered.map((a) => a.condition)).toEqual(["waiting-approval"])
        expect(t2.suppressed.map((a) => a.condition)).toEqual(["disk"])

        // Standing shows delivered alerts
        const st1 = yield* runtime.standing("run-a")
        expect(st1.every((s) => s.state === "delivered")).toBe(true)

        // Acknowledge waiting-approval -> idempotent true, suppresses future repeat
        const waitId = st1.find((s) => s.alert.condition === "waiting-approval")!.alertId
        expect(yield* runtime.acknowledge("run-a", waitId, "will")).toBe(true)
        expect(yield* runtime.acknowledge("run-a", waitId, "will")).toBe(true)
        expect(yield* runtime.acknowledge("run-a", "unknown-id", "will")).toBe(false)

        yield* TestClock.adjust("150 millis")
        const t3 = yield* runtime.tick("run-a")
        expect(t3.delivered).toEqual([])
        expect(t3.suppressed.length).toBe(2)

        const st2 = yield* runtime.standing("run-a")
        const acked = st2.find((s) => s.alert.condition === "waiting-approval")!
        expect(acked.state).toBe("acknowledged")
        expect(acked.acknowledgedBy).toBe("will")
      }).pipe(Effect.provide(testLayer(Alerts.layerNoop)))
    )

    // 2. Failing sink & refused full queue in AlertRuntime
    const failingSink = Layer.succeed(Alerts.Sink)({
      deliver: () => Effect.fail(new Alerts.AlertError({ code: "sink_rejected", status: 503, message: "down" }))
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* Alerts.AlertRuntime
        yield* Alerts.report({ runId: "run-f", probe: "disk", state: "failing" })
        const t1 = yield* runtime.tick("run-f")
        expect(t1.failed.length).toBe(1)
        const st = yield* runtime.standing("run-f")
        expect(st[0]!.state).toBe("raised")
      }).pipe(Effect.provide(testLayer(failingSink)))
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* Alerts.AlertRuntime
        yield* Alerts.report({ runId: "run-full", probe: "disk", state: "failing" })
        const t1 = yield* runtime.tick("run-full")
        expect(t1.refused.length).toBe(1)
      }).pipe(Effect.provide(testLayer(Alerts.layerNoop, 0)))
    )

    // 3. Channels (Resend + Telegram) + Alerts.layerChannels + Alerts.layerWebhook via injected FetchHttpClient.Fetch
    const makeFetchLayer = (fn: typeof fetch) => Layer.succeed(FetchHttpClient.Fetch)(fn)

    const statuses = [
      { status: 200, body: { id: "em_1", ok: true, result: { message_id: 42 } }, headers: {} },
      { status: 200, body: { bad: true }, headers: {} },
      {
        status: 429,
        body: { name: "rate_limit_exceeded", parameters: { retry_after: 5 } },
        headers: { "retry-after": "3" }
      },
      { status: 500, body: { name: "unknown_err" }, headers: {} },
      { status: 401, body: {}, headers: {} },
      { status: 400, body: { name: "validation_error", description: "Bad Request: chat not found" }, headers: {} },
      { status: 302, body: {}, headers: { location: "https://evil.example/steal" } }
    ] as const

    for (const s of statuses) {
      const fetchLayer = makeFetchLayer(async () =>
        new Response(JSON.stringify(s.body), {
          status: s.status,
          headers: { "content-type": "application/json", ...s.headers }
        })
      )
      const chLayer = Channels.layer({
        email: { apiKey: Redacted.make("re_key"), from: "bot@example.com", url: "https://resend.test/" },
        telegram: { token: Redacted.make("123:tok"), url: "https://tg.test/" },
        timeout: Duration.seconds(2)
      }).pipe(Layer.provide(fetchLayer))

      const msg: Channels.Message = { id: "m1", subject: "sub", text: "body" }
      const emailRes = await Effect.runPromise(
        Effect.flatMap(Channels.Channels, (c) => c.send({ _tag: "email", to: ["a@b.com"] }, msg)).pipe(
          Effect.result,
          Effect.provide(chLayer)
        )
      )
      const tgRes = await Effect.runPromise(
        Effect.flatMap(Channels.Channels, (c) => c.send({ _tag: "telegram", chatId: "123" }, msg)).pipe(
          Effect.result,
          Effect.provide(chLayer)
        )
      )
      if (s.status === 200 && "id" in s.body) {
        expect(Result.isSuccess(emailRes)).toBe(true)
        expect(Result.isSuccess(tgRes)).toBe(true)
      } else {
        expect(Result.isFailure(emailRes)).toBe(true)
        expect(Result.isFailure(tgRes)).toBe(true)
      }

      // Alerts.layerChannels & Alerts.layerWebhook
      const sampleAlert: Alerts.Alert = {
        runId: "r1",
        condition: "disk",
        since: 1_000,
        firedAt: 1_000,
        severity: "critical",
        coalescingKey: "r1:disk"
      }
      const alertChLayer = Alerts.layerChannels({ destination: { _tag: "email", to: ["a@b.com"] } }).pipe(
        Layer.provide(chLayer)
      )
      const alertChRes = await Effect.runPromise(
        Effect.flatMap(Alerts.Sink, (sink) => sink.deliver(sampleAlert)).pipe(
          Effect.result,
          Effect.provide(alertChLayer)
        )
      )
      expect(Result.isSuccess(alertChRes)).toBe(s.status === 200 && "id" in s.body)

      const whLayer = Alerts.layerWebhook({
        url: "https://hooks.test/secret",
        headers: { authorization: "Bearer tok" },
        timeout: Duration.seconds(2)
      }).pipe(Layer.provide(fetchLayer))
      const whRes = await Effect.runPromise(
        Effect.flatMap(Alerts.Sink, (sink) => sink.deliver(sampleAlert)).pipe(
          Effect.result,
          Effect.provide(whLayer)
        )
      )
      expect(Result.isSuccess(whRes)).toBe(s.status === 200)
    }

    // Unreachable fetch, unconfigured channel, invalid destination/message, invalid provider/webhook URLs
    const errFetch = makeFetchLayer(async () => {
      throw new TypeError("network down")
    })
    const emptyCh = Channels.layer({}).pipe(Layer.provide(errFetch))
    const unconfRes = await Effect.runPromise(
      Effect.flatMap(
        Channels.Channels,
        (c) => c.send({ _tag: "email", to: ["a@b.com"] }, { id: "m", subject: "s", text: "t" })
      ).pipe(Effect.result, Effect.provide(emptyCh))
    )
    expect(Result.isFailure(unconfRes) && unconfRes.failure.code === "unconfigured").toBe(true)

    const badMsgRes = await Effect.runPromise(
      Effect.flatMap(
        Channels.Channels,
        (c) => c.send({ _tag: "telegram", chatId: "" }, { id: "", subject: "", text: "" })
      ).pipe(Effect.result, Effect.provide(emptyCh))
    )
    expect(Result.isFailure(badMsgRes) && badMsgRes.failure.code === "rejected").toBe(true)

    const netWh = Alerts.layerWebhook({ url: "https://hooks.test/x" }).pipe(Layer.provide(errFetch))
    const netWhRes = await Effect.runPromise(
      Effect.flatMap(
        Alerts.Sink,
        (s) => s.deliver({ runId: "r", condition: "c", since: 1, firedAt: 1, severity: "info", coalescingKey: "r:c" })
      ).pipe(Effect.result, Effect.provide(netWh))
    )
    expect(Result.isFailure(netWhRes) && netWhRes.failure.code === "sink_unreachable").toBe(true)

    // Invalid URLs die at layer build
    const badWhExit = await Effect.runPromise(
      Effect.exit(Effect.scoped(Layer.build(Alerts.layerWebhook({ url: "file:///etc/passwd" }))))
    )
    expect(badWhExit._tag).toBe("Failure")
    const badChExit = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Layer.build(Channels.layer({ email: { apiKey: Redacted.make("k"), from: "a@b.com", url: "ftp://bad" } }))
        )
      )
    )
    expect(badChExit._tag).toBe("Failure")
  })
})
