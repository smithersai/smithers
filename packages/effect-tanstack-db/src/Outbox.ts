/**
 * A durable outbox for TanStack DB writes, through
 * `@tanstack/offline-transactions`, as an Effect service.
 *
 * A write is an offline transaction: its optimistic rows show at once, the
 * transaction is stored durably (IndexedDB in a browser) before anything is
 * sent, and the library sends it with its own backoff, one at a time in the
 * order written, across reloads and restarts. Each named mutation is an
 * Effect; this module turns its typed failures into the library's retry
 * decisions:
 *
 * - `Refused`: the server refused the write for good; it is never sent again
 *   and its optimistic rows roll back;
 * - `Retry`: the write didn't get through (the network, a 5xx, a 429, a
 *   deadline); the library sends it again after its backoff, 1 second
 *   doubling to 60, jittered, or at once on `retryNow` or the browser coming
 *   back online;
 * - a defect is never retried, and is logged.
 *
 * Only a program that leads the outbox, with durable storage, admits a write.
 * `transact` never takes the library's online-only path for followers; it
 * fails with `NotAdmitted` instead. Who leads is injected (`leader`); without
 * one, the library elects with its own Web Lock.
 *
 * `withdraw` takes back a write not sent yet, under the same lock a send
 * claims its write with, so a write is never both sent and taken back.
 *
 * The host supplies the library's entry point and storage as arguments
 * (`startOfflineExecutor`, `IndexedDBAdapter`), so this module imports and
 * runs anywhere Effect does.
 *
 * @since 0.2.0
 */

import type {
  LeaderElection,
  OfflineConfig,
  OfflineExecutor,
  OnlineDetector,
  StorageAdapter
} from "@tanstack/offline-transactions"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import type * as Stream from "effect/Stream"
import * as SubscriptionRef from "effect/SubscriptionRef"
import * as Tracer from "effect/Tracer"
import type { Collection } from "./Collection.ts"
import { errorName } from "./internal/errorName.ts"
import { type MutationRefused, TransactionFailed } from "./internal/model.ts"
import type { OutboxUpgrade } from "./Migrations.ts"

/**
 * The server refused a write for good: it is never sent again, and its
 * optimistic rows roll back. `status` is the HTTP status, when there was one.
 *
 * @category errors
 * @since 0.2.0
 */
export class Refused extends Data.TaggedError("Refused")<{ readonly status?: number }> {}

/**
 * A write didn't get through and is sent again after the backoff: `status` is
 * the HTTP status (5xx, 408, 429), or absent for the network or a deadline.
 *
 * @category errors
 * @since 0.2.0
 */
export class Retry extends Data.TaggedError("Retry")<{ readonly status?: number }> {}

/**
 * The outbox didn't take a write, so nothing was stored or sent and its rows
 * rolled back:
 * - `follower`: another tab leads, including leadership lost before persistence;
 * - `storage`: the outbox's storage failed to store it.
 *
 * @category errors
 * @since 0.2.0
 */
export class NotAdmitted extends Data.TaggedError("NotAdmitted")<{
  readonly reason: "follower" | "storage"
}> {}

/**
 * `withdraw` didn't take the write back, so nothing changed:
 * - `follower`: this program doesn't lead the outbox, so another program may
 *   be sending the write;
 * - `gone`: no stored write waiting to be sent has that idempotency key: it
 *   was sent or refused already, isn't stored yet (`admitted` hasn't
 *   succeeded), or was never made;
 * - `sending`: the write is being sent now, or was just sent or refused and is
 *   leaving the storage; it settles as usual;
 * - `storage`: reading or deleting the outbox's storage failed; the write is
 *   sent as usual.
 *
 * @category errors
 * @since 0.2.0
 */
export class NotWithdrawn extends Data.TaggedError("NotWithdrawn")<{
  readonly reason: "follower" | "gone" | "sending" | "storage"
}> {}

/**
 * A named mutation: sends the rows of one write. `idempotencyKey` is the same
 * on every attempt, so the server can tell a resend from a new write.
 *
 * @category models
 * @since 0.2.0
 */
export type Mutation<R> = (params: {
  readonly rows: ReadonlyArray<unknown>
  readonly idempotencyKey: string
}) => Effect.Effect<void, Refused | Retry, R>

/**
 * Who leads the outbox: the library's `LeaderElection`, such as its own
 * `WebLocksLeader`, or the host's tab leader.
 *
 * @category models
 * @since 0.2.0
 */
export type Leader = LeaderElection

/**
 * Whether the network is there, and the signal to send now: the library's
 * `OnlineDetector`.
 *
 * @category models
 * @since 0.2.0
 */
export type Online = OnlineDetector

/**
 * What `layer` starts the outbox with.
 *
 * @category models
 * @since 0.2.0
 */
export interface Options<R> {
  /** The library's entry point: `startOfflineExecutor` from `@tanstack/offline-transactions`. */
  readonly start: (config: OfflineConfig) => OfflineExecutor
  /**
   * The collections writes may change, keyed by a name that never changes: a stored write names its collection by
   * this key, so a write queued by one version of a program is restored into the same collection by the next.
   */
  readonly collections: Readonly<Record<string, Collection<any, any, any>>>
  /** Where writes are stored: `new IndexedDBAdapter(...)` in a browser. */
  readonly storage: StorageAdapter
  /** Who leads. Defaults to the library's election: `WebLocksLeader` where Web Locks exist. */
  readonly leader?: Leader
  /** The network detector: the library's `WebOnlineDetector` in a browser, `Online.always()` elsewhere. */
  readonly online: Online
  readonly mutations: Readonly<Record<string, Mutation<R>>>
  /**
   * How writes cross builds: `Migrations.outbox(registry)`. Each write is stamped with its rows' versions, and before
   * the outbox loads the stored writes, each one an older build made is upgraded, or parked when it can't be.
   */
  readonly upgrade?: OutboxUpgrade | undefined
  /**
   * What takes a parked write of each mutation name, as its feature shows it Not sent. A handler that succeeds with
   * `true` took it, and the outbox deletes it; `false` leaves it parked. Each runs as the outbox starts.
   */
  readonly parked?: Readonly<Record<string, (write: Parked) => Effect.Effect<boolean, never, R>>> | undefined
  /**
   * Who this program writes as, so a write is sent only as who queued it. Without it, every stored write is this
   * program's.
   */
  readonly principal?: Principal | undefined
}

/**
 * Who a program writes as, read synchronously each time the outbox asks:
 * - `now`: the principal this program writes as at this moment, such as the person whose data it opened; none when it
 *   writes as nobody yet;
 * - `ownsUnstamped`: whether the writes stored before writes were stamped, which name no principal, are `now`'s.
 *
 * Each write `transact` makes is stamped with `now`. The outbox loads, shows and sends only the stored writes that are
 * the principal's: stamped with `now`, or unstamped when `ownsUnstamped`. Every other write stays in the storage,
 * sealed: never loaded, parked, sent or deleted, logged as `outbox write sealed`. A write whose principal changed after
 * it was loaded, and before it was sent, is sealed the same way as it comes up to be sent (`attempts` counts it
 * `sealed`): its rows roll back, `settled` fails, and the storage keeps it.
 *
 * @category models
 * @since 0.3.0
 */
export interface Principal {
  readonly now: () => string | undefined
  readonly ownsUnstamped: () => boolean
}

/**
 * A write the outbox parked because this build can't send it as it was
 * meant: its id and mutation `name`, why (`Migrations.UpgradedWrite`'s
 * reasons), and its rows as stored, which no schema checked.
 *
 * @category models
 * @since 0.3.0
 */
export interface Parked {
  readonly id: string
  readonly name: string
  readonly reason: string
  readonly rows: ReadonlyArray<unknown>
}

/**
 * The outbox's state, as `status` reports it:
 * - `leader`: this program leads the outbox, so it admits and sends writes;
 * - `failing`: the last send didn't get through, on the `network` or at the
 *   `server`; null once one does.
 *
 * @category models
 * @since 0.2.0
 */
export interface Status {
  readonly leader: boolean
  readonly failing: null | "network" | "server"
}

/**
 * A write the outbox took. Its rows show at once.
 *
 * @category models
 * @since 0.2.0
 */
export interface Write {
  readonly id: string
  /** Succeeds once the write is stored durably; fails with `NotAdmitted` if the storage refused it. */
  readonly admitted: Effect.Effect<void, NotAdmitted>
  /** Succeeds once the mutation succeeded; fails with `TransactionFailed` when the write rolled back. */
  readonly settled: Effect.Effect<void, TransactionFailed>
}

/**
 * The outbox.
 *
 * @category models
 * @since 0.2.0
 */
export interface Service {
  /**
   * Writes through mutation `name`: `mutate` runs at once, synchronously, inside the write, so its inserts, updates
   * and deletes show as optimistic rows until the write settles. Fails with `NotAdmitted` when this program doesn't
   * lead the outbox, and with `mutate`'s `MutationRefused`, after rolling the write back, when a change is refused.
   * The current span, if any, is stored with the write, and every send links to it.
   */
  readonly transact: (
    name: string,
    ids: { readonly idempotencyKey: string },
    mutate: Effect.Effect<void, MutationRefused>
  ) => Effect.Effect<Write, NotAdmitted | MutationRefused>
  /** The outbox's state now, then each change. */
  readonly status: Stream.Stream<Status>
  /** Sends every waiting write now instead of waiting out its backoff. */
  readonly retryNow: Effect.Effect<void>
  /**
   * Takes back a write not sent yet, by its idempotency key: it is deleted from the storage, never sent, and its
   * optimistic rows roll back, whether it was made by this program or restored after a reload. Its rows are gone when
   * `withdraw` succeeds, and its `settled` fails with `TransactionFailed`, whose cause is an error named
   * `OutboxWithdrawn`. The check and the moment a send claims its write share one lock, so a write is never both sent
   * and taken back: one being sent fails with `NotWithdrawn` `sending` and settles as usual. Fails with `follower`
   * when this program doesn't lead, `gone` when no write waiting to be sent has the key, and `storage` when the
   * storage can't be read or deleted from. Each call is a span, `outbox.withdraw`, with `outcome`.
   */
  readonly withdraw: (idempotencyKey: string) => Effect.Effect<void, NotWithdrawn>
  /** The writes parked now: ones an older build made that this build can't send as they were meant. */
  readonly parked: Effect.Effect<ReadonlyArray<Parked>>
  /** Deletes parked write `id`, logged as `outbox write discarded` with its name; one that isn't parked is no-op. */
  readonly discard: (id: string) => Effect.Effect<void>
}

/**
 * The outbox writes are made through.
 *
 * @category services
 * @since 0.2.0
 */
export class Outbox extends Context.Service<Outbox, Service>()("@smthrs/effect-tanstack-db/Outbox") {}

/**
 * Each send, by `name` and `outcome`: `sent`, `retry`, `refused` or `defect`; `sent_elsewhere`, a write this
 * program queued that another program sent and deleted while this one followed, settled here without sending it;
 * `withdrawn`, a write `withdraw` took back, settled without sending it; or `sealed`, a write another principal queued
 * (`Options.principal`), never sent and kept in the storage.
 *
 * @category metrics
 * @since 0.2.0
 */
export const attempts = Metric.counter("outbox_attempts", {
  description: "Sends of outbox writes, by mutation name and outcome",
  incremental: true
})

/**
 * Writes the server refused, by `name` and `status`.
 *
 * @category metrics
 * @since 0.2.0
 */
export const refused = Metric.counter("outbox_refused", {
  description: "Outbox writes the server refused for good, by mutation name and status",
  incremental: true
})

/**
 * Milliseconds from a write to its mutation succeeding, by `name`.
 *
 * @category metrics
 * @since 0.2.0
 */
export const queuedMs = Metric.histogram("outbox_queued_ms", {
  description: "Milliseconds from an outbox write to its mutation succeeding",
  boundaries: Metric.exponentialBoundaries({ start: 50, factor: 2, count: 14 })
})

/**
 * Times this program became, or stopped being, the outbox's leader, by `leader`.
 *
 * @category metrics
 * @since 0.2.0
 */
export const leaderChanges = Metric.counter("outbox_leader_changes", {
  description: "Times this program took or lost the outbox's leadership",
  incremental: true
})

/**
 * Stored writes an older build made that this build upgraded (`outcome:
 * upgraded`) or parked (`outcome: parked`, with `reason`), by `name`.
 *
 * @category metrics
 * @since 0.3.0
 */
export const carried = Metric.counter("outbox_carried", {
  description: "Stored outbox writes from an older build, upgraded or parked, by mutation name, outcome and reason",
  incremental: true
})

// The library's storage key for a write (`OutboxManager`).
const KEY_PREFIX = "tx:"
// Where a parked write waits: the library never loads it.
const PARKED_PREFIX = "parked:"

/** A parked write as stored: why, its mutation's name, and the write as the library stored it. */
interface StoredParked {
  readonly reason: string
  readonly name: string
  readonly write: string
}

/** A stored write's mutation name and rows, as far as they can be read. */
const readWrite = (stored: string): { readonly name: string; readonly rows: ReadonlyArray<unknown> } => {
  try {
    const parsed = JSON.parse(stored) as { readonly mutationFnName?: unknown; readonly mutations?: unknown }
    return {
      name: typeof parsed.mutationFnName === "string" ? parsed.mutationFnName : "unknown",
      rows: Array.isArray(parsed.mutations)
        ? parsed.mutations.map((mutation: { readonly modified?: unknown }) => mutation.modified)
        : []
    }
  } catch {
    return { name: "unknown", rows: [] }
  }
}

/**
 * Upgrades every stored write an older build made, before the library loads
 * them: rewrites one it can bring forward, and moves one it can't to
 * `parked:<id>`. Each is logged and counted in `carried`; a storage that fails
 * leaves the write as it was.
 */
const carry = (storage: StorageAdapter, upgrade: OutboxUpgrade) =>
  Effect.gen(function*() {
    const keys = yield* Effect.tryPromise(() => storage.keys())
    for (const key of keys.filter((key) => key.startsWith(KEY_PREFIX))) {
      const stored = yield* Effect.tryPromise(() => storage.get(key))
      if (stored === null) continue
      const upgraded = upgrade.write(stored)
      if (upgraded._tag === "Current") continue
      const { name } = readWrite(stored)
      if (upgraded._tag === "Upgraded") {
        yield* Effect.tryPromise(() => storage.set(key, upgraded.value))
        yield* Metric.update(Metric.withAttributes(carried, { name, outcome: "upgraded", reason: "none" }), 1)
        yield* Effect.logInfo("outbox write upgraded").pipe(Effect.annotateLogs({ name }))
        continue
      }
      const parked: StoredParked = { reason: upgraded.reason, name, write: stored }
      yield* Effect.tryPromise(() =>
        storage.set(`${PARKED_PREFIX}${key.slice(KEY_PREFIX.length)}`, JSON.stringify(parked))
      )
      yield* Effect.tryPromise(() => storage.delete(key))
      yield* Metric.update(Metric.withAttributes(carried, { name, outcome: "parked", reason: upgraded.reason }), 1)
      yield* Effect.logWarning("outbox write parked").pipe(
        Effect.annotateLogs({ name, reason: upgraded.reason, stage: "upgrade" })
      )
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("outbox couldn't upgrade its writes").pipe(Effect.annotateLogs({ error: errorName(error) }))
    ),
    Effect.withSpan("outbox.carry")
  )

/** The writes parked in `storage` that are `principal`'s. A storage that fails reads as none, and is logged. */
const parkedIn = (storage: StorageAdapter, principal: Principal | undefined): Effect.Effect<ReadonlyArray<Parked>> =>
  Effect.gen(function*() {
    const keys = yield* Effect.tryPromise(() => storage.keys())
    const writes: Array<Parked> = []
    for (const key of keys.filter((key) => key.startsWith(PARKED_PREFIX))) {
      const stored = yield* Effect.tryPromise(() => storage.get(key))
      if (stored === null) continue
      const parked = JSON.parse(stored) as StoredParked
      if (!owns(principal, stampOf(parked.write))) continue
      writes.push({
        id: key.slice(PARKED_PREFIX.length),
        name: parked.name,
        reason: parked.reason,
        rows: readWrite(parked.write).rows
      })
    }
    return writes
  }).pipe(Effect.catch((error) =>
    Effect.as(
      Effect.logWarning("outbox couldn't read its parked writes").pipe(Effect.annotateLogs({ error: errorName(error) })),
      []
    )
  ))


// The error names a mutation's failure becomes. Their messages are fixed, so the library's substring rules never read
// anything else, and `shouldRetry` decides on the name alone.
const RETRY = "OutboxRetry"
const WITHDRAWN = "OutboxWithdrawn"

const thrown = (name: string, message: string): Error => Object.assign(new Error(message), { name })

// A write another principal queued, as it comes up to be sent: its mutation's `name`.
class Sealed extends Data.TaggedError("Sealed")<{ readonly name: string }> {}

/**
 * What a write carries besides its rows: when it was made, the span it was made in, and the version of each payload
 * collection when the outbox carries writes across builds (`Options.upgrade`).
 */
interface Metadata {
  readonly queuedAt: number
  readonly trace?: { readonly traceId: string; readonly spanId: string }
  readonly versions?: Readonly<Record<string, number>>
  /** Who queued the write (`Options.principal`); absent on a write stored before writes were stamped. */
  readonly principal?: string
}

// The principal a stored write names in its metadata, or none: unstamped, or not a write the library stored.
const stampOf = (stored: string): string | undefined => {
  try {
    const principal = (JSON.parse(stored) as { readonly metadata?: { readonly principal?: unknown } }).metadata
      ?.principal
    return typeof principal === "string" ? principal : undefined
  } catch {
    return undefined
  }
}

// Whether a write stamped `stamp` (none: unstamped) is `principal`'s now. Without a principal, every write is.
const owns = (principal: Principal | undefined, stamp: string | undefined): boolean =>
  principal === undefined || (stamp === undefined ? principal.ownsUnstamped() : stamp === principal.now())

/**
 * Starts the outbox and waits until it has loaded the writes stored earlier,
 * restored their rows, and asked to lead. Each mutation runs with the services
 * of the fiber that builds the layer. Each send is a span, `outbox.send`, with
 * `name`, `attempt` and `outcome`, linked to the span the write was made in,
 * and is counted in `attempts`. The outbox stops when the layer closes.
 *
 * @category layers
 * @since 0.2.0
 */
export const layer = <R>(options: Options<R>): Layer.Layer<Outbox, never, R> =>
  Layer.effect(
    Outbox,
    Effect.gen(function*() {
      const context = yield* Effect.context<R>()
      const run = Effect.runSyncWith(context)
      const status = yield* SubscriptionRef.make<Status>({ leader: false, failing: null })
      const setStatus = (next: Partial<Status>) => run(SubscriptionRef.update(status, (now) => ({ ...now, ...next })))

      // One permit for the moment a send claims its write and for `withdraw`, so a write is never both sent and
      // taken back.
      const permit = yield* Semaphore.make(1)
      // The write this program's send claimed, held until the library is done with it. The library sends one write at
      // a time. A write sent or refused stays held until the library deletes it, so `withdraw` finds it held or gone.
      // A write to be sent again (`retry`) is released once the library has stored its next attempt, so `withdraw`
      // never deletes it under that store.
      let inFlight: { readonly id: string; readonly retry: boolean } | undefined
      // Writes `withdraw` took back that the library hasn't reached yet: when it does, the send settles them unsent.
      const withdrawn = new Set<string>()
      // Each write this program made, until it settles: `withdraw` waits for it, so its rows are gone when it returns.
      const live = new Map<string, Promise<void>>()

      // Admission is the storage write of the write's own key; whoever waits on a write learns of it here.
      const admissions = new Map<string, Deferred.Deferred<void, NotAdmitted>>()
      // Another principal's stored write is sealed: the library never sees it, so it never loads, sends or deletes it.
      const sealed = (key: string, stored: string | null) =>
        key.startsWith(KEY_PREFIX) && stored !== null && !owns(options.principal, stampOf(stored))
      const seal = (stored: string, stage: "load" | "send") =>
        run(
          Effect.logWarning("outbox write sealed").pipe(Effect.annotateLogs({ name: readWrite(stored).name, stage }))
        )
      const ownKeys = async () => {
        const keys = await options.storage.keys()
        if (options.principal === undefined) return keys
        const own: Array<string> = []
        for (const key of keys) {
          const stored = key.startsWith(KEY_PREFIX) ? await options.storage.get(key) : null
          if (!sealed(key, stored)) own.push(key)
          else seal(stored!, "load")
        }
        return own
      }
      const storage: StorageAdapter = {
        get: options.principal === undefined ? options.storage.get.bind(options.storage) : async (key) => {
          const stored = await options.storage.get(key)
          return sealed(key, stored) ? null : stored
        },
        keys: ownKeys,
        delete: options.principal === undefined ? options.storage.delete.bind(options.storage) : async (key) => {
          if (sealed(key, await options.storage.get(key))) return
          await options.storage.delete(key)
        },
        clear: options.storage.clear.bind(options.storage),
        set: async (key, value) => {
          const id = key.slice(KEY_PREFIX.length)
          const admission = admissions.get(id)
          try {
            await options.storage.set(key, value)
          } catch (error) {
            // A real storage failure stays storage even if leadership was lost during the write.
            if (admission) run(Deferred.fail(admission, new NotAdmitted({ reason: "storage" })))
            throw error
          }
          if (inFlight?.retry === true && inFlight.id === id) inFlight = undefined
          if (admission) run(Deferred.succeed(admission, undefined))
        }
      }

      // Which send of each write this is, for its span; forgotten once the write settles.
      const sends = new Map<string, number>()
      const send = (name: string, mutation: Mutation<R>): OfflineConfig["mutationFns"][string] => (params) => {
        // Every write is made by `transact`, which stores its metadata.
        const { id, metadata } = params.transaction as unknown as { readonly id: string; readonly metadata: Metadata }
        const attempt = (sends.get(id) ?? 0) + 1
        sends.set(id, attempt)
        const trace = metadata.trace
        const outcome = (value: string): Effect.Effect<void> =>
          Effect.all([
            Effect.annotateCurrentSpan({ outcome: value }),
            Metric.update(Metric.withAttributes(attempts, { name, outcome: value }), 1)
          ], { discard: true })
        // A write is sent only while the storage holds it. One this program queued, then followed while another led,
        // may have been sent and deleted by the other: leading again, this program settles it without sending it twice.
        // A storage that can't be read doesn't stop a send.
        const stored = Effect.promise(() =>
          options.storage.get(`${KEY_PREFIX}${id}`).then((value) => value !== null, () => true)
        )
        const sending: Effect.Effect<void, Refused | Retry, R> = mutation({
          rows: params.transaction.mutations.map((change) => change.modified),
          idempotencyKey: params.idempotencyKey
        }).pipe(
          Effect.tap(() =>
            Effect.gen(function*() {
              yield* outcome("sent")
              yield* Metric.update(
                Metric.withAttributes(queuedMs, { name }),
                (yield* Clock.currentTimeMillis) - metadata.queuedAt
              )
            })
          ),
          // A refusal is final and logged; a write that will be sent again is logged on its first retry only, so a long
          // outage writes one line per write, while `attempts` counts every send.
          Effect.tapError((error): Effect.Effect<void> => {
            const status = String(error.status ?? "none")
            return error._tag === "Refused"
              ? Effect.all([
                outcome("refused"),
                Metric.update(Metric.withAttributes(refused, { name, status }), 1),
                Effect.logWarning("outbox write refused").pipe(Effect.annotateLogs({ name, status, outcome: "refused" }))
              ], { discard: true })
              : Effect.andThen(
                outcome("retry"),
                attempt === 1
                  ? Effect.logWarning("outbox write retrying").pipe(Effect.annotateLogs({ name, status, outcome: "retry" }))
                  : Effect.void
              )
          }),
          Effect.tapDefect((defect) =>
            Effect.all([
              outcome("defect"),
              Effect.logError("outbox write failed").pipe(
                Effect.annotateLogs({ name, outcome: "defect", "error.type": errorName(defect) })
              )
            ])
          )
        )
        // Under the permit, so `withdraw` sees this write either taken back, and it settles here unsent, or in flight.
        // A write queued by another principal than this program's now is never sent: it is sealed.
        const claim = permit.withPermit(Effect.gen(function*() {
          if (withdrawn.delete(id)) return "withdrawn" as const
          if (!(yield* stored)) return "sent_elsewhere" as const
          if (!owns(options.principal, metadata.principal)) return "sealed" as const
          inFlight = { id, retry: false }
          return "sent" as const
        }))
        // Succeeds with whether the write reached a server, which clears `failing`: a withdrawn one never did. A sealed
        // one fails, so its rows roll back; the library's delete leaves it in the storage, which is another's.
        const program = Effect.flatMap(claim, (claimed): Effect.Effect<boolean, Refused | Retry | Sealed, R> =>
          claimed === "sent"
            ? Effect.as(sending, true)
            : claimed === "sealed"
            ? Effect.andThen(
              outcome("sealed"),
              Effect.andThen(
                Effect.logWarning("outbox write sealed").pipe(Effect.annotateLogs({ name, stage: "send" })),
                Effect.fail(new Sealed({ name }))
              )
            )
            : Effect.as(outcome(claimed), claimed === "sent_elsewhere")).pipe(
            Effect.withSpan("outbox.send", {
              attributes: { name, attempt },
              ...(trace ? { links: [{ span: Tracer.externalSpan(trace), attributes: {} }] } : {})
            })
          )
        return Effect.runPromiseExitWith(context)(program).then((exit) => {
          if (Exit.isSuccess(exit)) {
            sends.delete(id)
            if (exit.value) {
              setStatus({ failing: null })
            }
            return
          }
          const error = Cause.findErrorOption(exit.cause)
          if (Option.isSome(error) && error.value._tag === "Retry") {
            // Free to withdraw again once the library has stored its next attempt.
            inFlight = { id, retry: true }
            setStatus({ failing: error.value.status === undefined ? "network" : "server" })
            throw thrown(RETRY, "The write didn't get through; it is sent again.")
          }
          sends.delete(id)
          setStatus({ failing: null })
          throw Option.isSome(error)
            ? error.value._tag === "Sealed"
              ? thrown("OutboxSealed", "Another principal queued the write; it is never sent as this one.")
              : thrown("OutboxRefused", "The server refused the write.")
            : thrown("OutboxDefect", "The write failed with a defect.")
        })
      }

      // The writes an older build stored are brought forward, or parked, before the library loads any.
      if (options.upgrade !== undefined) {
        yield* carry(storage, options.upgrade)
      }

      const executor = yield* Effect.acquireRelease(
        Effect.sync(() =>
          options.start({
            collections: Object.fromEntries(
              Object.entries(options.collections).map(([key, collection]) => [key, collection.tanstack])
            ),
            storage,
            ...(options.leader ? { leaderElection: options.leader } : {}),
            onlineDetector: options.online,
            mutationFns: Object.fromEntries(
              Object.entries(options.mutations).map(([name, mutation]) => [name, send(name, mutation)])
            ),
            // Only a mutation's `Retry` is sent again: the library's own rules (an `AbortError`, a message with "400")
            // never see another error.
            shouldRetry: (error) =>
              error.name === RETRY,
            onLeadershipChange: (leader) => {
              setStatus({ leader })
              run(Metric.update(Metric.withAttributes(leaderChanges, { leader: String(leader) }), 1))
            }
          })
        ),
        (executor) =>
          Effect.sync(() => executor.dispose())
      )
      yield* Effect.tryPromise(() => executor.waitForInit()).pipe(
        Effect.catch((error) =>
          Effect.logWarning("outbox couldn't load its writes").pipe(Effect.annotateLogs({ error: errorName(error) }))
        )
      )

      // Who a write is queued by, stamped into its metadata when the outbox has a principal.
      const principalStamp = (): { readonly principal?: string } => {
        const now = options.principal?.now()
        return now === undefined ? {} : { principal: now }
      }

      const transact: Service["transact"] = (name, { idempotencyKey }, mutate) =>
        Effect.gen(function*() {
          // A follower would get the library's online-only transaction, with no storage and no retry: refuse instead.
          if (!executor.isOfflineEnabled) return yield* new NotAdmitted({ reason: "follower" })
          const services = yield* Effect.context<never>()
          const span = yield* Effect.option(Effect.currentSpan)
          const metadata: Metadata = {
            queuedAt: yield* Clock.currentTimeMillis,
            ...(Option.isSome(span) ? { trace: { traceId: span.value.traceId, spanId: span.value.spanId } } : {}),
            ...(options.upgrade === undefined ? {} : { versions: options.upgrade.stamp }),
            ...principalStamp()
          }
          const offline = executor.createOfflineTransaction({
            mutationFnName: name,
            idempotencyKey,
            autoCommit: false,
            metadata: { ...metadata }
          })
          // The library calls `mutate` synchronously, inside the transaction, so its writes join it.
          const changed: { exit: Exit.Exit<void, MutationRefused> } = { exit: Exit.void }
          const transaction = offline.mutate(() => {
            changed.exit = Effect.runSyncExitWith(services)(mutate)
          })
          if (Exit.isFailure(changed.exit)) {
            offline.rollback()
            return yield* Effect.failCause(changed.exit.cause)
          }
          const admission = yield* Deferred.make<void, NotAdmitted>()
          admissions.set(transaction.id, admission)
          live.set(
            transaction.id,
            transaction.isPersisted.promise.then(() => undefined, () => undefined).finally(() =>
              live.delete(transaction.id)
            )
          )
          // Admitted, the write settles through the executor; refused by the storage, it rolls back before that.
          void offline.commit().catch(() => undefined)
          void transaction.isPersisted.promise.then(
            () => run(Deferred.succeed(admission, undefined)),
            () =>
              run(Deferred.fail(
                admission,
                new NotAdmitted({
                  reason: executor.isOfflineEnabled ? "storage" : "follower"
                })
              ))
          ).finally(() => admissions.delete(transaction.id))
          return {
            id: transaction.id,
            admitted: Deferred.await(admission),
            settled: Effect.tryPromise({
              try: () => transaction.isPersisted.promise,
              catch: (cause) => new TransactionFailed({ cause })
            }).pipe(Effect.asVoid)
          } satisfies Write
        })

      const notWithdrawn = (reason: NotWithdrawn["reason"]) => new NotWithdrawn({ reason })
      const withdraw: Service["withdraw"] = (idempotencyKey) =>
        permit.withPermit(Effect.uninterruptible(Effect.gen(function*() {
          // A follower's view of the storage is no lock: the leader may be sending the write.
          if (!executor.isOfflineEnabled) return yield* notWithdrawn("follower")
          const writes = yield* Effect.tryPromise({
            try: () => executor.peekOutbox(),
            catch: () => notWithdrawn("storage")
          })
          const write = writes.find((entry) => entry.idempotencyKey === idempotencyKey)
          if (write === undefined) return yield* notWithdrawn("gone")
          // A write with an `outboxPhase` was sent or refused, and only its deletion is left.
          if (write.outboxPhase !== undefined || inFlight?.id === write.id) return yield* notWithdrawn("sending")
          yield* Effect.tryPromise({
            try: () => executor.removeFromOutbox(write.id),
            catch: () => notWithdrawn("storage")
          })
          withdrawn.add(write.id)
          // Rejects the waiter of a write made here, whose transaction rolls its rows back, or rolls back a restored
          // write's rows at once.
          executor.rejectTransaction(write.id, thrown(WITHDRAWN, "The write was withdrawn before it was sent."))
          return write
        }))).pipe(
          Effect.tap((write) => Effect.promise(() => live.get(write.id) ?? Promise.resolve())),
          Effect.tap((write) =>
            Effect.all([
              Effect.annotateCurrentSpan({ outcome: "withdrawn" }),
              Effect.logInfo("outbox write withdrawn").pipe(Effect.annotateLogs({ name: write.mutationFnName }))
            ], { discard: true })
          ),
          Effect.tapError(({ reason }) =>
            Effect.all([
              Effect.annotateCurrentSpan({ outcome: reason }),
              (reason === "storage" ? Effect.logWarning : Effect.logDebug)("outbox write not withdrawn").pipe(
                Effect.annotateLogs({ reason })
              )
            ], { discard: true })
          ),
          Effect.asVoid,
          Effect.withSpan("outbox.withdraw")
        )

      const discard: Service["discard"] = (id) =>
        Effect.gen(function*() {
          const key = `${PARKED_PREFIX}${id}`
          const stored = yield* Effect.tryPromise(() => options.storage.get(key))
          if (stored === null) return
          if (!owns(options.principal, stampOf((JSON.parse(stored) as StoredParked).write))) return
          yield* Effect.tryPromise(() => options.storage.delete(key))
          yield* Effect.logInfo("outbox write discarded").pipe(
            Effect.annotateLogs({ name: (JSON.parse(stored) as StoredParked).name })
          )
        }).pipe(Effect.catch((error) =>
          Effect.logWarning("outbox couldn't discard a parked write").pipe(Effect.annotateLogs({ error: errorName(error) }))
        ))

      // Each parked write goes to its feature, which shows it Not sent; one it took leaves the outbox.
      // One no feature takes stays parked, never sent: it is logged again on each load, so it is never forgotten silently.
      for (const write of yield* parkedIn(options.storage, options.principal)) {
        const take = options.parked?.[write.name]
        if (take !== undefined && (yield* take(write))) yield* discard(write.id)
        else {
          yield* Effect.logWarning("outbox write parked").pipe(
            Effect.annotateLogs({ name: write.name, reason: write.reason, stage: "load" })
          )
        }
      }

      return Outbox.of({
        transact,
        status: SubscriptionRef.changes(status),
        retryNow: Effect.sync(() => executor.getOnlineDetector().notifyOnline()),
        withdraw,
        parked: parkedIn(options.storage, options.principal),
        discard
      })
    })
  )

/**
 * Network detectors for the outbox.
 *
 * @category constructors
 * @since 0.2.0
 */
export const Online = {
  /**
   * Always online: the outbox sends whenever it has a write, and `retryNow`
   * sends at once. For Node, a Worker or a test, where the browser's detector
   * has no `online` event to follow.
   */
  always: (): Online => {
    const listeners = new Set<() => void>()
    return {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      notifyOnline: () => {
        for (const listener of listeners) listener()
      },
      isOnline: () => true,
      dispose: () => listeners.clear()
    }
  }
}

/**
 * A lock service: `hold(name)` waits until this program holds the exclusive
 * lock `name`, and holds it until the scope closes; with `steal`, it takes the
 * lock at once from whichever program holds it. `tryHold(name)` takes it only
 * when no program holds it or waits for it, and answers none otherwise. `lost`
 * completes when another program steals it. `@smthrs/platform-browser`'s
 * `WebLock` is one.
 *
 * @category models
 * @since 0.2.0
 */
export interface Lock {
  readonly hold: (
    name: string,
    options?: { readonly steal?: boolean }
  ) => Effect.Effect<{ readonly lost: Effect.Effect<void> }, never, Scope.Scope>
  readonly tryHold: (
    name: string
  ) => Effect.Effect<Option.Option<{ readonly lost: Effect.Effect<void> }>, never, Scope.Scope>
}

/**
 * A leader for the outbox over a lock service, so the outbox shares the
 * host's one election mechanism. Unlike the library's `WebLocksLeader`, a
 * program that doesn't get the lock waits for it, so when the leader closes,
 * the next one leads and restores the writes it stored. `requestLeadership`
 * answers what the lock says, however long it takes to say it: `true` when the
 * lock was free and this program now holds it, `false` when another program
 * holds it or waits for it. A lock granted later is reported through
 * `onLeadershipChange`.
 *
 * `take` makes this program lead at once, as the tab a person is using should:
 * it steals the lock unless this program leads already, and completes once it
 * leads. The program it took the lead from stops leading, and waits for the
 * lock again, so it leads again once this one closes. The lock is released
 * when the outbox stops or the scope closes.
 *
 * @category constructors
 * @since 0.2.0
 */
export const lockLeader = (options: {
  readonly lock: Lock
  readonly name: string
}): Effect.Effect<
  Leader & { readonly take: Effect.Effect<void>; readonly dispose: () => void },
  never,
  Scope.Scope
> =>
  Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    const fork = Effect.runForkWith(context)
    const listeners = new Set<(leader: boolean) => void>()
    let leader = false
    let holding: Fiber.Fiber<void> | undefined
    // Whoever waits for this program to lead, told whether it does: `requestLeadership`'s answer and `take`.
    const waiting = new Set<(led: boolean) => void>()
    const tell = (led: boolean) => {
      const told = [...waiting]
      waiting.clear()
      for (const hear of told) hear(led)
    }
    const set = (next: boolean) => {
      if (next === leader) return
      leader = next
      for (const listener of listeners) listener(next)
      // After the outbox heard: whoever waited may write at once.
      if (next) tell(true)
    }
    // Takes the lock and holds it until the scope closes; stolen, it waits for it again. `wait` waits in line, `steal`
    // takes it at once, and `try` takes it only if it is free: held elsewhere, `taken` hears so, and it waits in line.
    // It starts once `holding` names it.
    const take = (how: "wait" | "steal" | { readonly taken: () => void }) =>
      typeof how === "object"
        ? Effect.flatMap(
          options.lock.tryHold(options.name),
          Option.match({
            onSome: Effect.succeed,
            onNone: () => Effect.andThen(Effect.sync(how.taken), options.lock.hold(options.name))
          })
        )
        : options.lock.hold(options.name, how === "steal" ? { steal: true } : undefined)
    // A lock manager that refuses the request (a defect of the lock service) leaves this program not leading: whoever
    // waits hears so, and the next `requestLeadership` or `take` asks again.
    const hold = (how: "wait" | "steal" | { readonly taken: () => void }) => {
      holding = fork(
        Effect.scoped(
          Effect.yieldNow.pipe(
            Effect.andThen(take(how)),
            Effect.tap(() => Effect.sync(() => set(true))),
            Effect.flatMap((held) => held.lost)
          )
        ).pipe(
          Effect.andThen(Effect.sync(() => {
            set(false)
            hold("wait")
          })),
          Effect.catchDefect((defect) =>
            Effect.andThen(
              Effect.logWarning("outbox lock refused").pipe(
                Effect.annotateLogs({ error: defect instanceof Error ? defect.name : typeof defect })
              ),
              Effect.sync(() => {
                holding = undefined
                set(false)
                tell(false)
              })
            )
          )
        )
      )
    }
    // Interrupted at once, so a hold let go never leads: a wait is withdrawn, a held lock released.
    const letGo = () => {
      holding?.interruptUnsafe()
      holding = undefined
    }
    // Let go, nobody waits any more: a `requestLeadership` not yet answered answers that this program doesn't lead.
    const release = () => {
      letGo()
      set(false)
      tell(false)
    }
    yield* Effect.addFinalizer(() => Effect.sync(release))
    return {
      requestLeadership: () =>
        new Promise<boolean>((answer) => {
          if (leader) return answer(true)
          // A hold already in line, or a take under way, reports its grant through `onLeadershipChange`.
          if (holding !== undefined) return answer(false)
          waiting.add(answer)
          hold({
            taken: () => {
              waiting.delete(answer)
              answer(false)
            }
          })
        }),
      releaseLeadership: release,
      isLeader: () => leader,
      onLeadershipChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      take: Effect.callback<void>((resume) => {
        if (leader) return resume(Effect.void)
        // It completes only once this program leads: a release before then leaves it to be interrupted.
        const led = (now: boolean) => {
          if (now) resume(Effect.void)
        }
        waiting.add(led)
        // The wait in line is withdrawn: the steal replaces it.
        letGo()
        hold("steal")
        return Effect.sync(() => waiting.delete(led))
      }),
      dispose: () => {
        release()
        listeners.clear()
      }
    }
  })
