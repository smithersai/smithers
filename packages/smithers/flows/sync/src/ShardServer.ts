/**
 * The sequencer of one shard: the only writer of its total order.
 *
 * `make` answers protocol v2 over a {@link ShardStore}, a synchronous port
 * whose `atomic` runs a body all-or-nothing. That is the shape of a Durable
 * Object's `storage.transactionSync` over `storage.sql`, of `node:sqlite`'s
 * `DatabaseSync`, and of {@link memoryStore}, so the same sequencer runs on
 * any SQLite host. Every submit decides and writes inside one `atomic`:
 *
 * - a request under another epoch is answered `StaleEpoch`, before anything is
 *   read or written;
 * - a key seen before is answered from its receipt: `Duplicate` or the same
 *   `Refused` for the same content, `IdempotencyConflict` for different
 *   content;
 * - otherwise `decide` runs and an accepted command takes `head + 1`, so the
 *   order is gapless and monotonic.
 *
 * A `decide` that throws is a defect: the body rolls back and nothing is
 * written.
 *
 * @since 1.0.0-rc.18
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  type Command,
  type CommandKey,
  contentHash,
  type Entry,
  type PullRequest,
  type PullResponse,
  ShardError,
  type ShardId,
  type ShardPosition,
  type SnapshotResponse,
  SubmitRequest,
  type SubmitResponse
} from "./ShardProtocol.ts"

/**
 * What the shard holds besides its entries: the authority's epoch, the last
 * seq, and the compaction floor with the state folded through it.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface Head {
  readonly epoch: number
  readonly head: number
  readonly floor: number
  readonly snapshot: Schema.Json
}

/**
 * A command key's answer, kept so a retry gets the same one. `seq` is `null`
 * for a refusal.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface Receipt {
  readonly hash: string
  readonly epoch: number
  readonly seq: number | null
  readonly reason: string | null
}

/**
 * The storage a shard runs on. Every method is synchronous; `atomic` runs its
 * body so that all of its writes land or, when it throws, none do.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface ShardStore {
  readonly atomic: <A>(body: () => A) => A
  readonly head: () => Head
  readonly setHead: (head: Head) => void
  readonly receipt: (key: CommandKey) => Receipt | undefined
  readonly putReceipt: (key: CommandKey, receipt: Receipt) => void
  readonly append: (entry: Entry) => void
  /** Up to `limit` entries after `after`, in order. */
  readonly read: (after: number, limit: number) => ReadonlyArray<Entry>
  /** Drops the entries through `seq`. */
  readonly dropThrough: (seq: number) => void
}

/**
 * The authority's verdict on one command: the events to sequence, or the
 * reason it is refused.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Decision =
  | { readonly _tag: "Accepted"; readonly events: ReadonlyArray<Schema.Json> }
  | { readonly _tag: "Refused"; readonly reason: string }

/**
 * One shard's sequencer.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface ShardServer {
  readonly shard: ShardId
  /** Runs `onAccepted` inside the transaction for a newly sequenced command. */
  readonly submit: (
    request: SubmitRequest,
    onAccepted?: (position: ShardPosition) => void
  ) => Effect.Effect<SubmitResponse, ShardError>
  readonly pull: (request: PullRequest) => Effect.Effect<PullResponse, ShardError>
  readonly snapshot: (shard: ShardId) => Effect.Effect<SnapshotResponse, ShardError>
  readonly head: Effect.Effect<ShardPosition>
  /**
   * Folds history through `seq` into `state` and drops the entries it covers.
   * A `seq` that is not a safe integer in `floor..head` fails `out_of_range`
   * and changes nothing.
   */
  readonly compact: (seq: number, state: Schema.Json) => Effect.Effect<ShardPosition, ShardError>
  /** Fences the current authority: every writer and reader under it is refused or resynced. */
  readonly advanceEpoch: Effect.Effect<ShardPosition>
}

const keyText = (key: CommandKey) => JSON.stringify(key)

const copy = <A>(value: A): A => structuredClone(value)

/**
 * A shard store in memory. `atomic` restores the state it found when its body
 * throws. It keeps its own copy of every entry and snapshot, and hands out
 * copies, so a caller that changes a value it submitted or read never changes
 * what the shard holds.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const memoryStore = (): ShardStore => {
  let head: Head = { epoch: 0, head: 0, floor: 0, snapshot: null }
  let entries: Array<Entry> = []
  let receipts = new Map<string, Receipt>()
  return {
    atomic: (body) => {
      const saved = { head, entries: [...entries], receipts: new Map(receipts) }
      try {
        return body()
      } catch (defect) {
        ;({ head, entries, receipts } = saved)
        throw defect
      }
    },
    head: () => copy(head),
    setHead: (next) => void (head = copy(next)),
    receipt: (key) => receipts.get(keyText(key)),
    putReceipt: (key, receipt) => void receipts.set(keyText(key), receipt),
    append: (entry) => void entries.push(copy(entry)),
    read: (after, limit) => copy(entries.filter((entry) => entry.seq > after).slice(0, limit)),
    dropThrough: (seq) => void (entries = entries.filter((entry) => entry.seq > seq))
  }
}

const decodeSubmit = Schema.decodeUnknownEffect(SubmitRequest)

const acceptAll = (command: Command): Decision => ({ _tag: "Accepted", events: [command.payload] })

/**
 * The sequencer of `shard` over `store`. `decide` defaults to accepting every
 * command with its payload as the one event.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const make = (options: {
  readonly shard: ShardId
  readonly store?: ShardStore
  readonly decide?: (command: Command) => Decision
}): ShardServer => {
  const { shard } = options
  const store = options.store ?? memoryStore()
  const decide = options.decide ?? acceptAll
  const at = (epoch: number, seq: number): ShardPosition => ({ shard, epoch, seq })
  const owned = (requested: ShardId): Effect.Effect<void, ShardError> =>
    requested === shard
      ? Effect.void
      : Effect.fail(
        new ShardError({ reason: "wrong_shard", message: `this sequencer owns ${shard}, not ${requested}` })
      )

  const sequence = (request: SubmitRequest, hash: string): SubmitResponse => {
    const { key } = request.command
    const current = store.head()
    if (request.epoch !== current.epoch) return { _tag: "StaleEpoch", key, shard, epoch: current.epoch }
    const prior = store.receipt(key)
    if (prior !== undefined) {
      const position = prior.seq === null ? null : at(prior.epoch, prior.seq)
      if (prior.hash !== hash) return { _tag: "IdempotencyConflict", key, shard, position }
      return position === null
        ? { _tag: "Refused", key, shard, reason: prior.reason! }
        : { _tag: "Duplicate", key, position }
    }
    const decision = decide(request.command)
    if (decision._tag === "Refused") {
      store.putReceipt(key, { hash, epoch: current.epoch, seq: null, reason: decision.reason })
      return { _tag: "Refused", key, shard, reason: decision.reason }
    }
    const seq = current.head + 1
    store.append({ seq, epoch: current.epoch, key, stream: request.command.stream, events: decision.events })
    store.putReceipt(key, { hash, epoch: current.epoch, seq, reason: null })
    store.setHead({ ...current, head: seq })
    return { _tag: "Accepted", key, position: at(current.epoch, seq) }
  }

  const page = (request: PullRequest): PullResponse => {
    const current = store.head()
    if (request.epoch !== current.epoch || request.after < current.floor || request.after > current.head) {
      return { _tag: "Resync", shard, epoch: current.epoch, snapshotSeq: current.floor }
    }
    // The order is gapless, so the page ends at the limit or the head.
    const through = Math.min(request.after + request.limit, current.head)
    return {
      _tag: "Page",
      shard,
      epoch: current.epoch,
      entries: store.read(request.after, request.limit),
      through,
      head: current.head,
      done: through === current.head
    }
  }

  return {
    shard,
    submit: (request, onAccepted) =>
      Effect.gen(function*() {
        yield* owned(request.shard)
        const valid = yield* decodeSubmit(request).pipe(
          Effect.mapError(() => new ShardError({ reason: "out_of_range", message: "Invalid shard submit request" }))
        )
        const hash = yield* contentHash(valid.command)
        return store.atomic(() => {
          const reply = sequence(valid, hash)
          if (reply._tag === "Accepted") onAccepted?.(reply.position)
          return reply
        })
      }),
    pull: (request) => owned(request.shard).pipe(Effect.map(() => store.atomic(() => page(request)))),
    snapshot: (requested) =>
      owned(requested).pipe(
        Effect.map(() => {
          const current = store.atomic(store.head)
          return { position: at(current.epoch, current.floor), state: current.snapshot }
        })
      ),
    head: Effect.sync(() => {
      const current = store.head()
      return at(current.epoch, current.head)
    }),
    compact: (seq, state) =>
      Effect.suspend(() =>
        store.atomic(() => {
          const current = store.head()
          if (!Number.isSafeInteger(seq) || seq < current.floor || seq > current.head) {
            return Effect.fail(
              new ShardError({
                reason: "out_of_range",
                message: `cannot compact through ${seq}: retained history is ${current.floor}..${current.head}`
              })
            )
          }
          store.dropThrough(seq)
          store.setHead({ ...current, floor: seq, snapshot: state })
          return Effect.succeed(at(current.epoch, seq))
        })
      ),
    advanceEpoch: Effect.sync(() =>
      store.atomic(() => {
        const current = store.head()
        store.setHead({ ...current, epoch: current.epoch + 1 })
        return at(current.epoch + 1, current.head)
      })
    )
  }
}
