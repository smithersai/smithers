/**
 * The pending queue, its journal projection, inbox routing and alert policy against their Lean 4 reference
 * specification (`spec/lean/notifications`), generated: every case is answered by the implementation and by the
 * specification's compiled oracle, and the two answers must be equal.
 *
 * The oracle is one process for the whole file. It reads one JSON request per line and writes one JSON response per
 * line. A text crosses as its UTF-16 code units, so a lone surrogate arrives as it left, and an absent value crosses
 * as `null`.
 *
 * A developer's machine with neither the built oracle nor `lake` skips the differential cases; a machine with `lake`
 * builds the oracle first, and builds it again when a source of the specification is newer than it. The regression
 * cases at the end need no oracle and always run.
 */
import { Fuzz } from "@smthrs/fuzz"
import { JournalEvent } from "@smthrs/journal"
import { Arbitrary, Effect, Schema } from "effect"
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { recordSourceId } from "../src/AlertPolicy.ts"
import { Alerts, Inbox, Notification, NotificationEvent, NotificationState, Projection } from "../src/index.ts"

const baseExecutions = Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? (process.env["EFFECT_FUZZ"] ? "500" : "100"))
const executions = Math.max(25, Math.min(baseExecutions, 150))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261123")

// --- the oracle -----------------------------------------------------------------------------------------------------

const specDir = join(import.meta.dirname, "..", "spec", "lean", "notifications")
const binary = join(specDir, ".lake", "build", "bin", "notifications-spec")
const elan = join(homedir(), ".elan", "bin")
const lake = [...(process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== ""), elan]
  .map((directory) => join(directory, "lake"))
  .find((path) => existsSync(path))
/** The specification's sources are here and `lake` can build them. A confined run may be shown neither. */
const buildable = lake !== undefined && existsSync(join(specDir, "lakefile.toml"))
const oracleReady = existsSync(binary) || buildable
const differential = it.skipIf(!oracleReady)

/** True when a source of the specification is newer than the built oracle, or there is no built oracle. */
const stale = (): boolean => {
  if (!existsSync(binary)) return true
  const built = statSync(binary).mtimeMs
  const sources = [
    "Main.lean",
    "NotificationsSpec.lean",
    "lakefile.toml",
    "lean-toolchain",
    ...readdirSync(join(specDir, "NotificationsSpec")).map((name) => join("NotificationsSpec", name))
  ]
  return sources.some((source) => statSync(join(specDir, source)).mtimeMs > built)
}

interface Oracle {
  readonly ask: (op: string, request: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly asked: () => number
  readonly close: () => void
}

const start = (): Oracle => {
  const child: ChildProcessWithoutNullStreams = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] })
  const waiting: Array<{ readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void }> = []
  let asked = 0
  createInterface({ input: child.stdout }).on("line", (line) => {
    const next = waiting.shift()
    const response = JSON.parse(line) as { readonly ok?: unknown; readonly error?: string }
    if (response.error === undefined) next?.resolve(response.ok)
    else next?.reject(new Error(`the oracle refused: ${response.error}`))
  })
  child.on("close", () => {
    for (const each of waiting.splice(0)) each.reject(new Error("the oracle exited before it answered"))
  })
  return {
    ask: (op, request) =>
      new Promise((resolve, reject) => {
        asked++
        waiting.push({ resolve, reject })
        child.stdin.write(`${JSON.stringify({ op, ...request })}\n`)
      }),
    asked: () => asked,
    close: () => child.stdin.end()
  }
}

let oracle: Oracle

beforeAll(() => {
  if (!oracleReady) return
  if (lake !== undefined && buildable && stale()) {
    const built = spawnSync(lake, ["build"], {
      cwd: specDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, PATH: `${elan}${delimiter}${process.env["PATH"] ?? ""}` }
    })
    if (built.status !== 0) throw new Error(`lake build failed in ${specDir}:\n${built.stdout}\n${built.stderr}`)
  }
  oracle = start()
})

afterAll(() => {
  if (oracleReady) oracle.close()
})

// --- the wire -------------------------------------------------------------------------------------------------------

type Units = ReadonlyArray<number>

/** A text as its UTF-16 code units. */
const units = (text: string): Array<number> => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index))

/** An optional text: its code units, or `null` when absent. */
const maybeUnits = (text: string | undefined): Array<number> | null => text === undefined ? null : units(text)

const cell = new DataView(new ArrayBuffer(8))

/** A double the oracle reads: the decimal text of its 64 bits. */
const sent = (value: number): string => {
  cell.setFloat64(0, value)
  return cell.getBigUint64(0).toString()
}

/** A double as the oracle writes it; every NaN is `nan`. */
const bitsOf = (value: number): string => Number.isNaN(value) ? "nan" : sent(value)

type Json = Notification.Notification["payload"]

/** What the queue reads of a payload: whether it is a record, that record's string `kind`, and a token. */
const payloadWire = (payload: Json): unknown => {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const record = payload as Readonly<Record<string, Json>>
    return {
      record: true,
      kind: typeof record["kind"] === "string" ? units(record["kind"]) : null,
      token: typeof record["n"] === "number" ? record["n"] : 0
    }
  }
  const token = Array.isArray(payload) && typeof payload[1] === "number"
    ? payload[1]
    : typeof payload === "number"
    ? payload
    : 0
  return { record: false, kind: null, token }
}

const notificationWire = (notification: Notification.Notification): unknown => ({
  tag: notification._tag,
  id: units(notification.id),
  lineage: units(notification.targetLineageId),
  key: notification._tag === "system-event" ? maybeUnits(notification.coalescingKey) : null,
  payload: payloadWire(notification.payload)
})

const pendingWire = (item: NotificationState.Pending): unknown => ({
  notification: notificationWire(item.notification),
  seq: item.seq
})

const stateWire = (state: NotificationState.State): unknown => ({
  capacity: state.capacity,
  items: state.items.map(pendingWire)
})

const promotionWire = (promotion: NotificationState.Promotion): unknown => ({
  state: stateWire(promotion.state),
  promoted: promotion.promoted.map(pendingWire)
})

// --- generators -----------------------------------------------------------------------------------------------------

const int = (minimum: number, maximum: number) => Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum, maximum })))

const list = <S extends Schema.Top>(item: S, maxLength: number) =>
  Schema.Array(item).pipe(Schema.check(Schema.isMaxLength(maxLength)))

/** Fails the test with the shrunk counterexample unless the property holds for every generated value. */
const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  offset: number,
  property: (value: A) => Promise<void>
): Promise<void> => {
  const report = await Effect.runPromise(
    Fuzz.run(arbitrary, (value) => Effect.promise(async () => (await property(value), true)), {
      seed: seed + offset,
      executions
    })
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

/** `pool[index]`, and nothing one past the end: how an optional value is drawn. */
const at = <A>(pool: ReadonlyArray<A>, index: number): A | undefined => pool[index]

// --- the queue ------------------------------------------------------------------------------------------------------

const ids = ["n1", "n2", "n3", "é", "😺", "a/b", "n1 "] as const
const lineages = ["L1", "L2", "run/root", "L1 "] as const
const keys = ["k1", "k2", "", "é😺"] as const
const tags = ["human-steer", "human-followup", "system-event"] as const

/** Payloads the queue reads differently: the `outside_change` record, near misses, and values with no fields. */
const payloads: ReadonlyArray<(token: number) => Json> = [
  (n) => ({ kind: "other", n }),
  (n) => ({ kind: "outside_change", n }),
  (n) => ({ n }),
  (n) => ["outside_change", n],
  (n) => n,
  () => "outside_change",
  () => null,
  (n) => ({ kind: 7, n }),
  (n) => ({ kind: "outside_change ", n }),
  (n) => ({ kind: ["outside_change"], n }),
  (n) => ({ kind: null, n }),
  (n) => ({ KIND: "outside_change", n })
]

const provenance: Notification.Provenance = {
  sourceRunId: "op",
  sourceLineageId: "op/root",
  sourceTurn: 1,
  sourceActor: "person:will"
}

interface Made {
  readonly tag: number
  readonly id: number
  readonly lineage: number
  readonly key: number
  readonly payload: number
}

const made = Schema.Struct({
  tag: int(0, tags.length - 1),
  id: int(0, ids.length - 1),
  lineage: int(0, lineages.length - 1),
  key: int(0, keys.length),
  payload: int(0, payloads.length - 1)
})

const notificationOf = (input: Made, token: number): Notification.Notification => {
  const common = {
    id: ids[input.id]!,
    targetLineageId: lineages[input.lineage]!,
    provenance,
    payload: payloads[input.payload]!(token)
  }
  const tag = tags[input.tag]!
  if (tag === "human-steer") return { _tag: tag, delivery: "steer", ...common }
  if (tag === "human-followup") return { _tag: tag, delivery: "queue", ...common }
  const key = at(keys, input.key)
  return { _tag: tag, delivery: "queue", ...common, ...(key === undefined ? {} : { coalescingKey: key }) }
}

const queueOp = Schema.Union([
  Schema.Struct({ op: Schema.Literal("admit"), notification: made }),
  Schema.Struct({ op: Schema.Literal("admit"), notification: made }),
  Schema.Struct({
    op: Schema.Literal("promoteSteers"),
    lineage: int(0, lineages.length),
    cutoffBack: int(-1, 4),
    unbounded: Schema.Boolean
  }),
  Schema.Struct({ op: Schema.Literal("promoteQueued"), lineage: int(0, lineages.length) }),
  Schema.Struct({
    op: Schema.Literal("promoteIds"),
    lineage: int(0, lineages.length),
    ids: list(int(0, ids.length - 1), 3)
  }),
  Schema.Struct({ op: Schema.Literal("applyPromoted"), ids: list(int(0, ids.length - 1), 3) })
])

const decisions = ["admitted", "coalesced", "rejected-full"] as const

describe("the pending queue against the Lean specification", () => {
  differential("every admission and promotion moves the queue as the specification does", async () => {
    let coalesced = 0
    let rejected = 0
    let promoted = 0
    await holds(
      Arbitrary.schema(Schema.Struct({ capacity: int(0, 5), chatty: Schema.Boolean, ops: list(queueOp, 18) })),
      1,
      async ({ capacity, chatty, ops }) => {
        let state = NotificationState.empty(capacity)
        let seq = 0
        for (const op of ops) {
          seq++
          const before = stateWire(state)
          if (op.op === "admit") {
            // A chatty producer reports under two keys to two lineages, so its events meet and coalesce.
            const notification = notificationOf(
              chatty
                ? { ...op.notification, lineage: op.notification.lineage % 2, key: op.notification.key % 2 }
                : op.notification,
              seq
            )
            const wire = notificationWire(notification)
            const admission = NotificationState.admit(state, notification, seq)
            expect({ state: stateWire(admission.state), decision: admission.decision }).toEqual(
              await oracle.ask("admitOne", { state: before, notification: wire, seq })
            )
            for (const decision of decisions) {
              expect(stateWire(NotificationState.applyAdmission(state, notification, seq, decision))).toEqual(
                await oracle.ask("applyAdmission", { state: before, notification: wire, seq, decision })
              )
            }
            // What the specification proves: replay of the committed decision is the live transition, the bound
            // holds, and a refusal leaves the queue as it was.
            expect(NotificationState.applyAdmission(state, notification, seq, admission.decision)).toEqual(
              admission.state
            )
            expect(admission.state.items.length).toBeLessThanOrEqual(Math.max(capacity, state.items.length))
            if (admission.decision === "rejected-full") expect(admission.state).toBe(state)
            if (admission.decision === "coalesced") coalesced++
            if (admission.decision === "rejected-full") rejected++
            state = admission.state
            continue
          }
          if (op.op === "applyPromoted") {
            const named = op.ids.map((index) => ids[index]!)
            const next = NotificationState.applyPromoted(state, named)
            expect(stateWire(next)).toEqual(await oracle.ask("applyPromoted", { state: before, ids: named.map(units) }))
            expect(stateWire(NotificationState.applyPromoted(next, named))).toEqual(stateWire(next))
            state = next
            continue
          }
          const lineage = at(lineages, op.lineage)
          let promotion: NotificationState.Promotion
          if (op.op === "promoteSteers") {
            const cutoff = op.unbounded ? Infinity : seq - op.cutoffBack
            promotion = NotificationState.promoteSteers(state, cutoff, lineage)
            expect(promotionWire(promotion)).toEqual(
              await oracle.ask("promoteSteers", {
                state: before,
                cutoff: op.unbounded ? null : cutoff,
                lineage: maybeUnits(lineage)
              })
            )
          } else if (op.op === "promoteQueued") {
            promotion = NotificationState.promoteQueued(state, lineage)
            expect(promotionWire(promotion)).toEqual(
              await oracle.ask("promoteQueued", { state: before, lineage: maybeUnits(lineage) })
            )
            expect(promotion.promoted.length).toBeLessThanOrEqual(1)
          } else {
            const named = op.ids.map((index) => ids[index]!)
            promotion = NotificationState.promoteIds(state, named, lineage)
            expect(promotionWire(promotion)).toEqual(
              await oracle.ask("promoteIds", { state: before, ids: named.map(units), lineage: maybeUnits(lineage) })
            )
          }
          for (const admission of ["steer", "queue"] as const) {
            expect(NotificationState.pending(state, admission, lineage).map(pendingWire)).toEqual(
              await oracle.ask("pending", { state: before, admission, lineage: maybeUnits(lineage) })
            )
          }
          expect(promotion.promoted.length + promotion.state.items.length).toBe(state.items.length)
          promoted += promotion.promoted.length
          state = promotion.state
        }
      }
    )
    expect(coalesced).toBeGreaterThan(0)
    expect(rejected).toBeGreaterThan(0)
    expect(promoted).toBeGreaterThan(0)
  })

  differential("a notification is classified as the specification classifies it", async () => {
    await holds(Arbitrary.schema(made), 2, async (input) => {
      const notification = notificationOf(input, 3)
      expect({
        admission: Notification.admissionClass(notification),
        coalesceKey: maybeUnits(Notification.coalesceKey(notification) ?? undefined)
      }).toEqual(await oracle.ask("classify", { notification: notificationWire(notification) }))
    })
  })

  differential("a capacity is normalized as the specification normalizes it, to the bit", async () => {
    const capacities = [0, -0, 1, 0.5, -0.5, 0.999, 1.5, 4, 128, -1, -128.5, 2 ** 31, 2 ** 53, 1e300, -1e300, 5e-324]
    for (const capacity of [...capacities, Infinity, -Infinity, NaN]) {
      expect(bitsOf(NotificationState.empty(capacity).capacity)).toBe(
        await oracle.ask("normalizeCapacity", { capacity: sent(capacity) })
      )
    }
    expect(NotificationState.empty(NaN).capacity).toBe(0)
    expect(NotificationState.empty(-0).capacity).toBe(0)
    expect(Object.is(NotificationState.empty(-0.5).capacity, 0)).toBe(true)
  })
})

// --- the projection -------------------------------------------------------------------------------------------------

const sources = ["own", "wrong-id", "drain", "foreign"] as const
const entryTypes = ["admitted", "admitted", "promoted", "other"] as const

const journalEntry = Schema.Struct({
  type: int(0, entryTypes.length - 1),
  source: int(0, sources.length - 1),
  /** Whether the source and the payload follow from the type, as every record the queue writes does. */
  wellFormed: Schema.Boolean,
  body: int(0, 2),
  notification: made,
  decision: int(0, decisions.length - 1),
  versioned: Schema.Boolean,
  ids: list(int(0, ids.length - 1), 3)
})

describe("the journal projection against the Lean specification", () => {
  differential("Projection.derive folds admissions, edits, promotions and foreign entries as specified", async () => {
    let retained = 0
    await holds(Arbitrary.schema(list(journalEntry, 14)), 3, async (inputs) => {
      const entries: Array<JournalEvent.Entry> = []
      const wire: Array<unknown> = []
      for (const [index, input] of inputs.entries()) {
        const seq = index + 1
        const type = entryTypes[input.type]!
        const bodyKind = input.wellFormed
          ? (type === "other" ? "undecodable" : type)
          : (["admitted", "promoted", "undecodable"] as const)[input.body]!
        const source = input.wellFormed
          ? (type === "admitted" ? "own" : type === "promoted" ? "drain" : "foreign")
          : sources[input.source]!
        const notification = notificationOf(input.notification, seq)
        const named = input.ids.map((each) => ids[each]!)
        const decision = decisions[input.decision]!
        const sourceId = source === "own"
          ? NotificationEvent.admissionSourceId(notification.id)
          : source === "wrong-id"
          ? NotificationEvent.admissionSourceId(`${notification.id}x`)
          : source === "drain"
          ? NotificationEvent.drainSourceId("L1", `b-${seq}`)
          : JournalEvent.SourceId.make("/test")
        entries.push(
          new JournalEvent.Entry({
            runId: JournalEvent.RunId.make("r1"),
            seq: JournalEvent.Seq.make(seq),
            eventId: `ev-${seq}`,
            sourceId,
            sourceSeq: JournalEvent.SourceSeq.make(1),
            emittedAtMs: seq * 10,
            eventType: type === "admitted"
              ? NotificationEvent.AdmittedEventType
              : type === "promoted"
              ? NotificationEvent.PromotedEventType
              : "other.event",
            payload: bodyKind === "admitted"
              ? { notification, decision, ...(input.versioned ? { version: index } : {}) }
              : bodyKind === "promoted"
              ? { boundary: `b-${seq}`, targetLineageId: "L1", ids: named }
              : { x: 1 },
            meta: {}
          })
        )
        wire.push({
          type,
          sourceId: units(sourceId),
          seq,
          body: bodyKind === "admitted"
            ? { kind: bodyKind, notification: notificationWire(notification), decision, versioned: input.versioned }
            : bodyKind === "promoted"
            ? { kind: bodyKind, ids: named.map(units) }
            : { kind: bodyKind }
        })
      }
      let projected = Projection.derive.initial
      for (const entry of entries) projected = Effect.runSync(Projection.derive.reduce(projected, entry))
      expect(stateWire(projected)).toEqual(await oracle.ask("derive", { entries: wire }))
      retained += projected.items.length
    })
    expect(retained).toBeGreaterThan(0)
  })
})

// --- inbox routing --------------------------------------------------------------------------------------------------

const principals = ["ana", "ben", "cora", "dan", "é", "ana "] as const
const levels = ["all", "attention", "muted"] as const
const runStates = ["working", "waiting", "needs_you", "failed", "done"] as const
const acts = ["read", "dismiss", "hide"] as const

/** Versions a person could acknowledge and ones no notice has: negatives, and whole numbers past the safe range. */
const ackVersions = [0, 1, 2, 3, 5, 8, 13, 20, -1, -7, 2 ** 53 - 1, 2 ** 53, -(2 ** 53 - 1), -(2 ** 53)] as const

const noticeWire = (notice: Inbox.Versions): unknown => ({
  notice: [notice.version, notice.readVersion, notice.dismissedVersion, notice.hiddenVersion],
  open: Inbox.isOpen(notice),
  unread: Inbox.isUnread(notice),
  hidden: Inbox.isHidden(notice)
})

describe("inbox routing against the Lean specification", () => {
  differential("route and audience tell exactly the principals the specification tells, in its order", async () => {
    await holds(
      Arbitrary.schema(Schema.Struct({
        launcher: int(0, principals.length),
        state: int(0, runStates.length - 1),
        watchers: list(Schema.Struct({ principal: int(0, principals.length - 1), level: int(0, 2) }), 10),
        everyone: Schema.Boolean,
        blocked: list(int(0, principals.length - 1), 3)
      })),
      4,
      async (input) => {
        const launcher = at(principals, input.launcher)
        const state = runStates[input.state]!
        const watchers = input.watchers.map((watcher): Inbox.Watcher => ({
          principal: principals[watcher.principal]!,
          level: levels[watcher.level]!
        }))
        const blocked = input.blocked.map((index): string => principals[index]!)
        const mayRead = (principal: string): boolean => !blocked.includes(principal)
        const request = {
          watchers: watchers.map((watcher) => [units(watcher.principal), watcher.level]),
          blocked: input.everyone ? null : blocked.map(units)
        }
        const deliveries = Inbox.route({ launcher, state, watchers, ...(input.everyone ? {} : { mayRead }) })
        expect(deliveries.map((delivery) => ({ ...delivery, recipient: units(delivery.recipient) }))).toEqual(
          await oracle.ask("route", { ...request, launcher: maybeUnits(launcher), state })
        )
        const audience = input.everyone ? Inbox.audience(watchers) : Inbox.audience(watchers, mayRead)
        expect(audience.map(units)).toEqual(await oracle.ask("audience", request))
        // What the specification proves: nobody is told twice, nobody blocked or muted is told, and only the
        // launcher is told the run needs them.
        const recipients = deliveries.map((delivery) => delivery.recipient)
        expect(new Set(recipients).size).toBe(recipients.length)
        if (!input.everyone) { for (const recipient of recipients) expect(blocked).not.toContain(recipient) }
        for (const delivery of deliveries) {
          if (!delivery.mine) expect(delivery.state).not.toBe("needs_you")
          else expect(delivery.recipient).toBe(launcher)
        }
      }
    )
  })

  differential("raises agrees for every pair of states, and for a run's first notice", async () => {
    for (const after of runStates) {
      for (const before of [undefined, ...runStates]) {
        expect(Inbox.raises(before, after)).toBe(await oracle.ask("raises", { before: before ?? null, after }))
      }
    }
  })

  differential("ack advances the marks the specification advances, and no others", async () => {
    await holds(
      Arbitrary.schema(Schema.Struct({
        version: int(-2, 15),
        marks: Schema.Tuple([int(-1, 15), int(-1, 15), int(-1, 15)]),
        ops: list(Schema.Struct({ act: int(0, 2), version: int(0, ackVersions.length - 1) }), 8)
      })),
      5,
      async (input) => {
        let notice: Inbox.Versions = {
          version: input.version,
          readVersion: input.marks[0],
          dismissedVersion: input.marks[1],
          hiddenVersion: input.marks[2]
        }
        for (const op of input.ops) {
          const act = acts[op.act]!
          const version = ackVersions[op.version]!
          const next = Inbox.ack(notice, act, version)
          expect(noticeWire(next)).toEqual(
            await oracle.ask("ack", {
              notice: [notice.version, notice.readVersion, notice.dismissedVersion, notice.hiddenVersion],
              act,
              version
            })
          )
          expect(Inbox.ack(next, act, version)).toEqual(next)
          expect(next.version).toBe(notice.version)
          notice = next
        }
      }
    )
  })
})

// --- alert policy ---------------------------------------------------------------------------------------------------

/** Condition names: the four shipped ones, a deployment's own, and names `Object.prototype` also holds. */
const conditionNames = [
  "waiting-approval",
  "failed",
  "stalled",
  "quota-parked",
  "custom",
  "site*lag",
  "toString",
  "constructor",
  "__proto__",
  "hasOwnProperty",
  "1",
  "a:b",
  "é/😺 %"
] as const
const fields = ["status", "health", "state", "waitingReason", "undefined", "summary", "toString"] as const
const values = ["waiting-approval", "failed", "stalled", "quota", "failing", "x", ""] as const
const eventTypeNames = [
  "control.*",
  "control.run.parked",
  "control.monitor.beat",
  "flows.alerts.probe.x",
  "flows.*",
  ".*",
  "*",
  "control.",
  "control",
  "other.ev",
  "x.*.*",
  "flows.alerts.delivered",
  "flows.alerts.failed",
  "flows.alerts.acknowledged",
  "flows.alerts.deliveredx",
  ".x"
] as const
const summaryKeys = ["summary", "status", "missing"] as const
const severities = ["info", "warning", "critical"] as const
const owners = ["oncall", "", "é"] as const
const runbooks = ["https://rb/default", "rb"] as const
const runIds = ["r1", "run:2", "é", "a/b c", "100%", "😺"] as const

/** Payload values a detector reads: the strings it watches for, a long one, and values that are not strings. */
const payloadValues: ReadonlyArray<unknown> = [
  ...values,
  503,
  null,
  true,
  ["failed"],
  { status: "failed" },
  `${"s".repeat(498)}😺😺tail`,
  "é".repeat(501)
]

const ruleSchema = Schema.Struct({
  name: int(0, conditionNames.length - 1),
  afterMs: int(0, 120),
  repeatMs: int(0, 40),
  severity: int(0, severities.length),
  owner: int(0, owners.length),
  runbook: int(0, runbooks.length)
})

const detectorSchema = Schema.Struct({
  name: int(0, conditionNames.length - 1),
  field: int(0, fields.length - 1),
  value: int(0, values.length - 1),
  eventTypes: Schema.Boolean,
  named: list(int(0, eventTypeNames.length - 1), 3),
  summary: int(0, summaryKeys.length)
})

const policySchema = Schema.Struct({
  defaults: Schema.Boolean,
  severity: int(0, severities.length),
  owner: int(0, owners.length),
  runbook: int(0, runbooks.length),
  rules: list(ruleSchema, 6),
  detectors: list(detectorSchema, 4),
  ownDetectors: Schema.Boolean
})

const ruleOf = (input: typeof ruleSchema.Type): Alerts.Rule => {
  const severity = at(severities, input.severity)
  const owner = at(owners, input.owner)
  const runbook = at(runbooks, input.runbook)
  return {
    afterMs: input.afterMs,
    ...(input.repeatMs === 0 ? {} : { repeatMs: input.repeatMs }),
    ...(severity === undefined ? {} : { severity }),
    ...(owner === undefined ? {} : { owner }),
    ...(runbook === undefined ? {} : { runbook })
  }
}

const detectorOf = (input: typeof detectorSchema.Type): Alerts.Detector => {
  const summary = at(summaryKeys, input.summary)
  return {
    field: fields[input.field]!,
    value: values[input.value] === "" ? "x" : values[input.value]!,
    ...(input.eventTypes ? { eventTypes: input.named.map((index) => eventTypeNames[index]!) } : {}),
    ...(summary === undefined ? {} : { summary })
  }
}

const policyOf = (input: typeof policySchema.Type): Alerts.Policy => {
  const severity = at(severities, input.severity)
  const owner = at(owners, input.owner)
  const runbook = at(runbooks, input.runbook)
  return {
    ...(input.defaults
      ? {
        defaults: {
          ...(severity === undefined ? {} : { severity }),
          ...(owner === undefined ? {} : { owner }),
          ...(runbook === undefined ? {} : { runbook })
        }
      }
      : {}),
    rules: Object.fromEntries(input.rules.map((rule) => [conditionNames[rule.name]!, ruleOf(rule)])),
    ...(input.ownDetectors
      ? {
        detectors: Object.fromEntries(
          input.detectors.map((detector) => [conditionNames[detector.name]!, detectorOf(detector)])
        )
      }
      : {})
  }
}

/** A policy as the oracle reads it: the own entries of its two records, in key order. */
const policyWire = (policy: Alerts.Policy): unknown => ({
  defaults: policy.defaults === undefined ? null : {
    severity: policy.defaults.severity ?? null,
    owner: maybeUnits(policy.defaults.owner),
    runbook: maybeUnits(policy.defaults.runbook)
  },
  rules: Object.entries(policy.rules).map(([name, rule]) => [units(name), {
    afterMs: rule.afterMs,
    repeatMs: rule.repeatMs ?? null,
    severity: rule.severity ?? null,
    owner: maybeUnits(rule.owner),
    runbook: maybeUnits(rule.runbook)
  }]),
  detectors: Object.entries(policy.detectors ?? {}).map(([name, detector]) => [units(name), {
    field: units(detector.field),
    value: units(detector.value),
    eventTypes: detector.eventTypes === undefined ? null : detector.eventTypes.map(units),
    summary: maybeUnits(detector.summary)
  }])
})

interface Read {
  readonly eventType: string
  readonly emittedAtMs: number
  readonly payload: unknown
}

/** An entry as a detector reads it. The policy reads three fields, so a case need not be a persistable entry. */
const entryOf = (read: Read): JournalEvent.Entry => read as JournalEvent.Entry

const entryWire = (read: Read): unknown => ({
  eventType: units(read.eventType),
  at: read.emittedAtMs,
  payload: typeof read.payload === "object" && read.payload !== null && !Array.isArray(read.payload)
    ? Object.entries(read.payload).map(([key, value]) => [units(key), typeof value === "string" ? units(value) : null])
    : null
})

const openWire = (open: Alerts.Open): unknown => ({
  runId: units(open.runId),
  condition: units(open.condition),
  since: open.since,
  summary: maybeUnits(open.summary)
})

const alertWire = (alert: Alerts.Alert): unknown => ({
  runId: units(alert.runId),
  condition: units(alert.condition),
  since: alert.since,
  firedAt: alert.firedAt,
  reminder: alert.reminder ?? null,
  severity: alert.severity,
  coalescingKey: units(alert.coalescingKey),
  summary: maybeUnits(alert.summary),
  owner: maybeUnits(alert.owner),
  runbook: maybeUnits(alert.runbook),
  id: units(Alerts.alertId(alert))
})

/** `decide` by the implementation and by the oracle: the same alerts and ids, or the same refusal to encode. */
const decideAgrees = async (
  policy: Alerts.Policy,
  open: ReadonlyArray<Alerts.Open>,
  now: number
): Promise<ReadonlyArray<Alerts.Alert> | undefined> => {
  const expected = await oracle.ask("decide", { policy: policyWire(policy), open: open.map(openWire), now })
  if (expected === null) {
    expect(() => Alerts.decide(policy, open, now)).toThrow(URIError)
    return undefined
  }
  const actual = Alerts.decide(policy, open, now)
  expect(actual.map(alertWire)).toEqual(expected)
  // Present optional members are never `undefined`: an alert is byte-identical on every attempt.
  for (const alert of actual) for (const value of Object.values(alert)) expect(value).not.toBeUndefined()
  return actual
}

const readSchema = Schema.Struct({
  eventType: int(1, eventTypeNames.length - 1),
  dt: int(0, 60),
  record: int(0, 9),
  fields: list(Schema.Struct({ key: int(0, fields.length - 1), value: int(0, payloadValues.length - 1) }), 3)
})

const readsOf = (
  inputs: ReadonlyArray<typeof readSchema.Type>
): { readonly reads: Array<Read>; readonly end: number } => {
  let time = 1_000
  const reads = inputs.map((input): Read => {
    time += input.dt
    const record = Object.fromEntries(input.fields.map((field) => [fields[field.key]!, payloadValues[field.value]]))
    const payload = input.record === 0 ? [record] : input.record === 1 ? null : input.record === 2 ? "failed" : record
    return { eventType: eventTypeNames[input.eventType]!, emittedAtMs: time, payload }
  })
  return { reads, end: time }
}

describe("alert policy against the Lean specification", () => {
  differential("conditions opens and closes what the specification does, and decide raises its alerts", async () => {
    let opened = 0
    let raised = 0
    let reminders = 0
    await holds(
      Arbitrary.schema(Schema.Struct({
        policy: policySchema,
        runId: int(0, runIds.length - 1),
        reads: list(readSchema, 12),
        later: int(0, 300)
      })),
      6,
      async (input) => {
        const policy = policyOf(input.policy)
        const runId = runIds[input.runId]!
        const { end, reads } = readsOf(input.reads)
        const open = Alerts.conditions(policy, runId, reads.map(entryOf))
        expect(open.map(openWire)).toEqual(
          await oracle.ask("conditions", {
            policy: policyWire(policy),
            runId: units(runId),
            entries: reads.map(entryWire)
          })
        )
        opened += open.length
        for (const now of [end, end + input.later, end + input.later * 7]) {
          const alerts = await decideAgrees(policy, open, now)
          raised += alerts?.length ?? 0
          for (const alert of alerts ?? []) {
            if (alert.reminder !== undefined) reminders++
            // What the specification proves: a page comes due no earlier than its condition opened, no later than
            // the instant it is judged at, and only once its delay has passed.
            expect(alert.firedAt).toBeGreaterThanOrEqual(alert.since)
            expect(alert.firedAt).toBeLessThanOrEqual(now)
            expect(now - alert.since).toBeGreaterThanOrEqual(policy.rules[alert.condition]!.afterMs)
          }
        }
      }
    )
    expect(opened).toBeGreaterThan(0)
    expect(raised).toBeGreaterThan(0)
    expect(reminders).toBeGreaterThan(0)
  })

  differential("the shipped detectors open and close the four shipped conditions as specified", async () => {
    let opened = 0
    await holds(
      Arbitrary.schema(Schema.Struct({
        rules: list(ruleSchema, 5),
        reads: list(
          Schema.Struct({
            kind: Schema.Literals(["wait", "resume", "stall", "healthy", "fail", "park", "unpark", "page", "step"]),
            dt: int(1, 60)
          }),
          14
        ),
        later: int(0, 250)
      })),
      7,
      async (input) => {
        const policy: Alerts.Policy = {
          rules: Object.fromEntries(input.rules.map((rule) => [conditionNames[rule.name % 4]!, ruleOf(rule)]))
        }
        let time = 1_000
        const reads = input.reads.map(({ dt, kind }): Read => {
          time += dt
          const [eventType, payload] = ({
            wait: ["control.run.parked", { status: "waiting-approval", waitingReason: "approval" }],
            resume: ["control.run.resumed", { status: "running" }],
            stall: ["control.monitor.beat", { health: "stalled" }],
            healthy: ["control.monitor.beat", { health: "healthy" }],
            fail: ["control.run.failed", { status: "failed" }],
            park: ["control.run.parked", { status: "waiting", waitingReason: "quota" }],
            unpark: ["control.run.resumed", { waitingReason: "none" }],
            page: [Alerts.deliveredEventType, { status: "503", health: "stalled" }],
            step: ["flow.step", { status: "failed", health: "stalled", waitingReason: "quota" }]
          } as const)[kind]
          return { eventType, emittedAtMs: time, payload }
        })
        const open = Alerts.conditions(policy, "r1", reads.map(entryOf))
        expect(open.map(openWire)).toEqual(
          await oracle.ask("conditions", {
            policy: policyWire(policy),
            runId: units("r1"),
            entries: reads.map(entryWire)
          })
        )
        opened += open.length
        await decideAgrees(policy, open, time + input.later)
      }
    )
    expect(opened).toBeGreaterThan(0)
  })

  differential("an event type is named exactly, or through a `.*` family, as the specification names it", async () => {
    for (const named of eventTypeNames) {
      for (const eventType of [...eventTypeNames, "", "controlx", "control.run.parked.more", ".", "x", "x.", "x.y.z"]) {
        const policy: Alerts.Policy = {
          rules: { c: { afterMs: 0 } },
          detectors: { c: { field: "f", value: "v", eventTypes: [named] } }
        }
        const read: Read = { eventType, emittedAtMs: 1, payload: { f: "v" } }
        const open = Alerts.conditions(policy, "r", [entryOf(read)])
        expect(open.map(openWire)).toEqual(
          await oracle.ask("conditions", { policy: policyWire(policy), runId: units("r"), entries: [entryWire(read)] })
        )
        const own = [Alerts.deliveredEventType, Alerts.failedEventType, Alerts.acknowledgedEventType]
        const family = named.endsWith(".*") ? eventType.startsWith(named.slice(0, -1)) : named === eventType
        expect(open.length).toBe(family && !own.includes(eventType) ? 1 : 0)
      }
    }
  })

  differential(
    "decide judges any open conditions as specified: unruled, hostile, and far past their delay",
    async () => {
      const hostile = [...conditionNames, "ghost", "", "\ud800", "a\udc00", "😺", "\udc00\ud800", "\0", "~!*'()-_."]
      await holds(
        Arbitrary.schema(Schema.Struct({
          policy: policySchema,
          open: list(
            Schema.Struct({
              runId: int(0, runIds.length + 1),
              condition: int(0, hostile.length - 1),
              since: int(-50, 2_000),
              summary: int(0, 2)
            }),
            6
          ),
          now: int(-100, 5_000),
          far: Schema.Boolean
        })),
        8,
        async (input) => {
          const policy = policyOf(input.policy)
          const open = input.open.map((each): Alerts.Open => ({
            runId: [...runIds, "\ud800", "r\udfff"][each.runId]!,
            condition: hostile[each.condition]!,
            since: each.since,
            ...(each.summary === 0 ? {} : { summary: ["", "said", "é😺"][each.summary]! })
          }))
          await decideAgrees(policy, open, input.far ? input.now + 2 ** 40 : input.now)
        }
      )
    }
  )

  differential("the keys and ids an alert is recorded under are the specification's, unit for unit", async () => {
    const texts = [...runIds, ...conditionNames, "", "a:b:c", "%3A", ":", "\u0000", "\u007f", "\u0080", "߿", "ࠀ"]
    for (const runId of texts) {
      for (const condition of ["stalled", "a:b", "é", "😺", "￿", ""]) {
        const key = Alerts.coalescingKey(runId, condition)
        expect(units(key)).toEqual(
          await oracle.ask("coalescingKey", { runId: units(runId), condition: units(condition) })
        )
        expect(units(recordSourceId(key, "failed/timeout"))).toEqual(
          await oracle.ask("recordSourceId", { id: units(key), outcome: units("failed/timeout") })
        )
      }
    }
    for (const lone of ["\ud800", "\udc00", "a\ud83d", "\ude3a\ud83d", "\ud83d😺"]) {
      expect(await oracle.ask("coalescingKey", { runId: units(lone), condition: units("c") })).toBeNull()
      expect(await oracle.ask("coalescingKey", { runId: units("r"), condition: units(lone) })).toBeNull()
      expect(() => Alerts.coalescingKey(lone, "c")).toThrow(URIError)
      expect(() => Alerts.coalescingKey("r", lone)).toThrow(URIError)
    }
    // A separator inside a component cannot forge another pair's key, as the specification proves.
    expect(Alerts.coalescingKey("a:b", "c")).not.toBe(Alerts.coalescingKey("a", "b:c"))
  })
})

describe("the oracle", () => {
  differential("refuses a request it does not know, and keeps answering", async () => {
    await expect(oracle.ask("nope", {})).rejects.toThrow("unknown op nope")
    await expect(oracle.ask("raises", { before: null, after: "paused" })).rejects.toThrow("the oracle refused")
    expect(await oracle.ask("raises", { before: null, after: "done" })).toBe(true)
  })

  differential("answered every differential case of this file", () => {
    expect(oracle.asked()).toBeGreaterThan(0)
    expect(oracle.asked()).toBeGreaterThan(executions * 20)
  })
})

// --- regressions the specification found ----------------------------------------------------------------------------

describe("alert policy reads only a policy's own rules and detectors", () => {
  it("decide raises nothing for an open condition named after an Object.prototype member", () => {
    const open = ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"].map((
      condition
    ): Alerts.Open => ({
      runId: "r",
      condition,
      since: 0
    }))
    expect(Alerts.decide({ rules: {} }, open, 10)).toEqual([])
    expect(Alerts.decide({ rules: { stalled: { afterMs: 0 } } }, open, 10)).toEqual([])
    // An own rule under such a name still decides.
    expect(Alerts.decide({ rules: { toString: { afterMs: 5 } } }, open, 10)).toEqual([{
      runId: "r",
      condition: "toString",
      since: 0,
      firedAt: 5,
      severity: "warning",
      coalescingKey: "r:toString"
    }])
  })

  it("conditions opens nothing for a rule whose only detector is an Object.prototype member", () => {
    const entry = entryOf({ eventType: "control.run.parked", emittedAtMs: 3, payload: { undefined } })
    for (const condition of ["toString", "constructor", "hasOwnProperty", "valueOf"]) {
      expect(Alerts.conditions({ rules: { [condition]: { afterMs: 0 } } }, "r", [entry])).toEqual([])
    }
    // An own detector under such a name still opens its condition.
    expect(
      Alerts.conditions(
        { rules: { constructor: { afterMs: 0 } }, detectors: { constructor: { field: "undefined", value: "v" } } },
        "r",
        [entryOf({ eventType: "x", emittedAtMs: 3, payload: { undefined: "v" } })]
      )
    ).toEqual([{ runId: "r", condition: "constructor", since: 3 }])
  })
})
