import type { Transcript } from "@smthrs/agent"
import { Clock, Effect, Option, Schema, Semaphore } from "effect"
import { RETENTION_MS } from "../../src/features/transcript/contract.ts"
import type { Frame } from "../../src/features/transcript/schema.ts"
import { codeOf } from "../ErrorCode.ts"
import * as SocketAccess from "../SocketAccess.ts"
import * as Store from "./RunContent.ts"

// What a run's `RunContent` Durable Object does (worker/RunContent.ts), over ports a test fills: its SQLite, its
// storage and alarm, its sockets, and the checks of who it admitted (worker/SocketAccess.ts). Each watcher's socket
// keeps its admission and lease as its attachment. Every send reads that attachment again right before it goes: a
// watcher dropped, past its lease or past its session's end gets nothing. A lapsed lease is renewed first, one renewal
// at a time per object, and one that can't be is dropped from the sending set, then closed. One alarm does two jobs:
// it forgets the transcript at its retention (`RETAIN_KEY`), and renews leases before they lapse. Storing events and
// moving the retention happen together, before any wait, and never beside forgetting. A socket from before leases (no
// attachment) is closed `1012` before this incarnation sends anything.

/** Storage key: when the transcript is forgotten, epoch milliseconds. */
export const RETAIN_KEY = "retain_until"

/** How long before its retention a new event moves it on: at most once an hour per run. */
const REARM_MS = 60 * 60 * 1000

/** A frame as the socket sends it. */
const frame = (value: Frame) => JSON.stringify(value)

/** What a watcher's socket keeps: who was admitted and their lease, or that this host dropped it. */
const Kept = Schema.Union([
  Schema.Struct({ admission: SocketAccess.Admission, leaseUntil: Schema.Number }),
  Schema.Struct({ dropped: Schema.Literal(true) }),
])
const decodeKept = Schema.decodeUnknownOption(Kept)

/** The object's storage: `SocketAccess.Storage`, and forgetting everything. */
export interface Storage<R> extends SocketAccess.Storage<R> {
  readonly deleteAll: () => Effect.Effect<void, never, R>
}

/** What a transcript host runs on. */
export interface Ports<R, RC> {
  readonly sql: Store.Sql
  readonly storage: Storage<R>
  readonly sockets: Effect.Effect<ReadonlyArray<SocketAccess.HostSocket>, never, R>
  readonly check: (admission: SocketAccess.Admission) => Effect.Effect<SocketAccess.Checked, never, RC>
  /** Runs one renewal with what `check` needs (one Postgres client in the object). */
  readonly within: <A>(renewal: Effect.Effect<A, never, RC | R>) => Effect.Effect<A, unknown, R>
}

/** One leased watcher. */
interface Watcher {
  readonly socket: SocketAccess.HostSocket
  readonly admission: SocketAccess.Admission
  readonly leaseUntil: number
}

/** Why a host won't take a socket ChatApi admitted: its session ended, or its person holds too many here. */
export type Refusal = "expired" | "crowded"

export const make = <R, RC>(ports: Ports<R, RC>) => {
  const { sql, storage } = ports
  /** Storing events with their retention, and forgetting the transcript, never run beside each other. */
  const lock = Semaphore.withPermits(Semaphore.makeUnsafe(1), 1)
  /** One renewal at a time: a send or alarm that finds one running waits for it. */
  const flight = SocketAccess.singleFlight()

  /** Every watcher still in the sending set; a socket from before leases is closed `1012` first. */
  const watchers = Effect.gen(function* () {
    const found: Array<Watcher> = []
    let legacy = 0
    for (const socket of yield* ports.sockets) {
      const kept = decodeKept(socket.deserializeAttachment<unknown>())
      if (Option.isSome(kept)) {
        if ("admission" in kept.value) found.push({ socket, ...kept.value })
        continue
      }
      legacy++
      socket.serializeAttachment({ dropped: true })
      yield* socket.close(SocketAccess.CLOSES.legacy.code, SocketAccess.CLOSES.legacy.reason).pipe(Effect.ignore)
    }
    yield* SocketAccess.countLegacy("transcript", legacy)
    return found
  })

  /** Leases `socket` to `admission` until `leaseUntil`. */
  const lease = (socket: SocketAccess.HostSocket, admission: SocketAccess.Admission, leaseUntil: number) =>
    socket.serializeAttachment({ admission, leaseUntil })

  /**
   * Sends `text` to `socket` only if, right now, it is still in the sending set, under a live lease and before its
   * session's end. Answers whether it went.
   */
  const sendNow = (socket: SocketAccess.HostSocket, text: string) =>
    Effect.gen(function* () {
      const kept = decodeKept(socket.deserializeAttachment<unknown>())
      if (Option.isNone(kept) || !("admission" in kept.value)) return false
      const now = yield* Clock.currentTimeMillis
      if (kept.value.leaseUntil <= now || SocketAccess.ended(kept.value.admission, now)) return false
      yield* socket.send(text).pipe(Effect.ignore)
      return true
    })

  /** Takes every one of `ending` out of the sending set, then closes each with its verdict's code. */
  const drop = (ending: ReadonlyArray<readonly [SocketAccess.HostSocket, SocketAccess.Closing]>) =>
    Effect.gen(function* () {
      for (const [socket] of ending) socket.serializeAttachment({ dropped: true })
      for (const [socket, closing] of ending) {
        yield* socket.close(SocketAccess.CLOSES[closing].code, SocketAccess.CLOSES[closing].reason).pipe(Effect.ignore)
      }
    })

  /** Renews `due`'s leases: answers those renewed; the rest are dropped and closed. */
  const renew = (due: ReadonlyArray<Watcher>) =>
    Effect.gen(function* () {
      if (due.length === 0) return []
      const verdicts = yield* SocketAccess.renew("transcript", due.map((each) => each.admission), ports.check, ports.within)
      const now = yield* Clock.currentTimeMillis
      const renewed: Array<Watcher> = []
      const ending: Array<readonly [SocketAccess.HostSocket, SocketAccess.Closing]> = []
      due.forEach((watcher, index) => {
        const { verdict, until, admission } = verdicts[index]!
        // A socket dropped while its check ran stays dropped.
        if (!decodeKept(watcher.socket.deserializeAttachment<unknown>()).pipe(Option.exists((kept) => "admission" in kept))) {
          return
        }
        if (verdict === "keep") {
          // The window its check measured, from when that check started (decision 0151 rule 9).
          const leaseUntil = until ?? SocketAccess.leaseFrom(watcher.admission, now)
          lease(watcher.socket, admission, leaseUntil)
          renewed.push({ ...watcher, admission, leaseUntil })
        } else ending.push([watcher.socket, verdict])
      })
      yield* drop(ending)
      return renewed
    })

  /** Renews every lease due now (`SocketAccess.due`), one renewal at a time. */
  const renewDue = flight(Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    yield* renew((yield* watchers).filter((watcher) => SocketAccess.due(watcher.admission, watcher.leaseUntil, now)))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("run_content.renew").pipe(Effect.annotateLogs({ errorCode: codeOf(cause) }))
    ),
  ))

  /**
   * When the transcript is forgotten. An object from before `RETAIN_KEY` kept it only as its alarm, which a renewal
   * may since have replaced: its deadline is its last event's time plus `RETENTION_MS`, never sooner than the alarm it
   * set, and is kept under the key from then on. A missing key never means expired.
   */
  const retention = Effect.gen(function* () {
    const until = yield* storage.get<number>(RETAIN_KEY)
    if (until !== undefined) return until
    const last = Store.lastAt(sql)
    if (last === undefined) return undefined
    yield* storage.put(RETAIN_KEY, last + RETENTION_MS)
    return last + RETENTION_MS
  })

  /** Arms the alarm for the retention or the next renewal, whichever comes first; never later than one already set. */
  const arm = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const until = yield* retention
    const renewal = SocketAccess.nextRenewal(yield* watchers, now)
    const next = Math.min(until ?? Infinity, renewal ?? Infinity)
    yield* SocketAccess.armAt(storage, next === Infinity ? undefined : next)
  })

  /** Moves the retention to `RETENTION_MS` after `now`, at most once an hour. */
  const retain = (now: number) =>
    Effect.gen(function* () {
      const until = yield* retention
      if (until === undefined || until < now + RETENTION_MS - REARM_MS) yield* storage.put(RETAIN_KEY, now + RETENTION_MS)
      yield* arm
    })

  /**
   * Stores `events` and moves the retention, together and before any wait; then renews lapsed leases and sends what
   * it stored to every watcher whose lease holds at the moment of its send.
   */
  const append = (generation: number, events: ReadonlyArray<Transcript.Event>) =>
    Effect.gen(function* () {
      const appended = yield* lock(Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const appended = Store.append(sql, generation, events, now)
        if (appended.stored.length > 0) yield* retain(now)
        return appended
      }))
      if (appended.stored.length > 0) {
        yield* renewDue
        const text = frame({ type: "events", events: appended.stored })
        for (const socket of yield* ports.sockets) yield* sendNow(socket, text)
      }
      return { next: appended.next, summary: appended.summary }
    })

  /** Whether the host takes a socket ChatApi admitted as `admission`, before it accepts it. */
  const admissible = (admission: SocketAccess.Admission) =>
    Effect.gen(function* () {
      if (SocketAccess.ended(admission, yield* Clock.currentTimeMillis)) return "expired" as Refusal
      const open = (yield* watchers).map((watcher) => watcher.admission)
      if (SocketAccess.crowded(open, admission.principal)) return "crowded" as Refusal
      return undefined
    })

  /**
   * An accepted socket, leased from its admission: every event after `after` in pages, then `live` with the run's
   * digest, each only under its lease, then each event as it is stored. The replay runs inside one event, so nothing
   * is stored between its pages. Answers the events it held.
   */
  const join = (socket: SocketAccess.HostSocket, admission: SocketAccess.Admission, after: number) =>
    Effect.gen(function* () {
      lease(socket, admission, SocketAccess.leaseFrom(admission, admission.admittedAt))
      const send = (text: string) =>
        Effect.gen(function* () {
          if (yield* sendNow(socket, text)) return
          const now = yield* Clock.currentTimeMillis
          if (decodeKept(socket.deserializeAttachment<unknown>()).pipe(Option.exists((kept) => "dropped" in kept))) return
          yield* drop([[socket, SocketAccess.ended(admission, now) ? "session" : "unverified"]])
        })
      let cursor = after
      for (;;) {
        const rows = Store.page(sql, cursor)
        if (rows.length === 0) break
        yield* send(frame({ type: "events", events: rows }))
        cursor = rows[rows.length - 1]!.n
      }
      const totals = Store.summary(sql)
      yield* send(frame({ type: "live", n: totals.last, digest: totals.digest }))
      yield* arm
      return totals.events
    })

  /** Closes every socket and forgets the transcript. */
  const forget = Effect.gen(function* () {
    for (const socket of yield* ports.sockets) yield* socket.close(1000, "forgotten").pipe(Effect.ignore)
    yield* storage.deleteAll()
    yield* Effect.logInfo("run_content.forget")
  })

  /**
   * The alarm: past the retention, the transcript is forgotten, never beside storing events; else every lease due is
   * renewed and the alarm armed again, after a failed renewal too. A failure to arm fails the alarm, which Cloudflare
   * retries.
   */
  const alarm = Effect.gen(function* () {
    const forgotten = yield* lock(Effect.gen(function* () {
      const until = yield* retention
      if (until === undefined || until > (yield* Clock.currentTimeMillis)) return false
      yield* forget
      return true
    }))
    if (forgotten) return
    yield* renewDue
    yield* arm
  })

  return { append, admissible, join, alarm, arm, restore: Effect.asVoid(watchers) }
}
