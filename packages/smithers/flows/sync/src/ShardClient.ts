/**
 * A node's side of protocol v2: a durable outbox it pushes to the shard, and
 * an applied cursor it pulls after.
 *
 * The client keeps three things in its {@link ClientStore}: the commands not
 * yet answered, the epoch it reads under, and the last seq its projection has
 * applied. The store is the only copy: every step reads it, and every change
 * is one `modify`, a read-and-write transaction, so a node that restarts, a
 * step that is interrupted, or a second client on the same store never works
 * from a stale copy:
 *
 * - `enqueue` takes the next command id and adds the command in one `modify`,
 *   so two clients sharing a store never take the same id.
 * - `push` submits every outbox command and removes them only once all have
 *   answered, so a failure part way loses no answer: the retry resubmits them
 *   all and the shard answers the ones it has seen from their receipts.
 *   Refusals and conflicts are recorded in the same transaction as dequeue.
 * - `pull` hands each page to `apply` and saves the cursor after `apply`
 *   succeeds, so `apply` sees every entry at least once, in order. A
 *   projection that keeps its own cursor in the same transaction sees each
 *   exactly once.
 * - A `Resync` answer is applied as a `Reset` to the shard's snapshot, and
 *   pulling continues after it.
 *
 * `push`, `pull` and `enqueue` on one client run one at a time, and each
 * `modify` runs uninterruptibly.
 *
 * @since 1.0.0-rc.18
 */

import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import {
  type Command,
  type Entry,
  protocolVersion,
  type PullRequest,
  type PullResponse,
  ShardError,
  type ShardId,
  type ShardPosition,
  type SnapshotResponse,
  type StreamId,
  type SubmitRequest,
  type SubmitResponse
} from "./ShardProtocol.ts"

/**
 * What a client persists.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface ClientState {
  readonly epoch: number
  readonly applied: number
  readonly nextCommand: number
  readonly outbox: ReadonlyArray<Command>
  readonly terminalFailures?: ReadonlyArray<TerminalFailure>
}

/**
 * An outbox command that the authority refused to sequence.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type TerminalFailure =
  | Omit<Extract<SubmitResponse, { readonly _tag: "Refused" }>, "shard">
  | Omit<Extract<SubmitResponse, { readonly _tag: "IdempotencyConflict" }>, "shard">

/**
 * Where a client persists its state: the node's local SQLite in production.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface ClientStore {
  readonly load: Effect.Effect<ClientState>
  /**
   * Reads the state, and saves the state `f` makes from it, as one
   * transaction: no other `modify` on the store runs in between.
   */
  readonly modify: <A>(f: (state: ClientState) => readonly [A, ClientState]) => Effect.Effect<A>
}

/**
 * How a client reaches the shard: a `ShardServer` in process, or HTTP.
 *
 * `TE` is how the transport itself fails, such as a request that got no
 * answer. An in-process transport has none. A client hands the failure to the
 * caller of `push`, `pull` or `sync` and keeps its outbox and cursor, so the
 * next call resumes.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface Transport<TE = never> {
  readonly submit: (request: SubmitRequest) => Effect.Effect<SubmitResponse, ShardError | TE>
  readonly pull: (request: PullRequest) => Effect.Effect<PullResponse, ShardError | TE>
  readonly snapshot: (shard: ShardId) => Effect.Effect<SnapshotResponse, ShardError | TE>
}

/**
 * What `pull` hands the projection: the next consecutive entries, or a
 * snapshot that replaces everything applied so far.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export type Delivery =
  | { readonly _tag: "Entries"; readonly entries: ReadonlyArray<Entry>; readonly through: ShardPosition }
  | { readonly _tag: "Reset"; readonly snapshot: SnapshotResponse }

/**
 * One node's connection to one shard.
 *
 * @category models
 * @since 1.0.0-rc.18
 */
export interface ShardClient<E = never, TE = never> {
  /** Adds a command to the outbox, saved before it returns. */
  readonly enqueue: (stream: StreamId, payload: Schema.Json) => Effect.Effect<Command>
  /** Submits every outbox command and returns each one's final answer, in order. */
  readonly push: Effect.Effect<ReadonlyArray<SubmitResponse>, ShardError | TE>
  /** Applies every entry after the cursor, through the shard's head, and returns the new cursor. */
  readonly pull: Effect.Effect<ShardPosition, ShardError | E | TE>
  /** `push`, then `pull`. */
  readonly sync: Effect.Effect<ShardPosition, ShardError | E | TE>
  readonly state: Effect.Effect<ClientState>
}

/**
 * The state of a client that has never run.
 *
 * @category constants
 * @since 1.0.0-rc.18
 */
export const initialState: ClientState = { epoch: 0, applied: 0, nextCommand: 0, outbox: [] }

/**
 * A client store in memory. Pass the same store to a new client to model a
 * node that restarts with its disk intact.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const memoryStore = (): ClientStore => {
  let state = initialState
  return {
    load: Effect.sync(() => state),
    modify: (f) =>
      Effect.sync(() => {
        const [result, next] = f(state)
        state = next
        return result
      })
  }
}

const keyText = (message: Pick<Command, "key">) => JSON.stringify(message.key)

/**
 * A client for `node` on `shard`, resuming from what `store` holds. Pages
 * are `limit` entries, 256 by default; a `limit` that is not a positive safe
 * integer is a defect.
 *
 * @category constructors
 * @since 1.0.0-rc.18
 */
export const make = <E = never, TE = never>(options: {
  readonly shard: ShardId
  readonly node: string
  readonly transport: Transport<TE>
  readonly store: ClientStore
  readonly apply: (delivery: Delivery) => Effect.Effect<void, E>
  readonly limit?: number
}): Effect.Effect<ShardClient<E, TE>> =>
  Effect.gen(function*() {
    const { shard, transport, store } = options
    const limit = options.limit ?? 256
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return yield* Effect.die(new RangeError(`ShardClient limit must be a positive safe integer, not ${limit}`))
    }
    const lock = yield* Semaphore.make(1)
    const modify = <A>(f: (state: ClientState) => readonly [A, ClientState]) => Effect.uninterruptible(store.modify(f))
    const save = (f: (state: ClientState) => ClientState) => modify((state) => [undefined, f(state)] as const)

    const wrongShard = () => new ShardError({ reason: "wrong_shard", message: "Response names a different shard" })

    const matchesShard = (response: SubmitResponse): boolean => {
      switch (response._tag) {
        case "Accepted":
        case "Duplicate":
          return response.position?.shard === shard
        case "StaleEpoch":
        case "Refused":
          return response.shard === shard
        case "IdempotencyConflict":
          return response.shard === shard && (response.position === null || response.position?.shard === shard)
      }
    }

    const submit = (command: Command, epoch: number): Effect.Effect<SubmitResponse, ShardError | TE> =>
      transport.submit({ version: protocolVersion, shard, epoch, command }).pipe(
        // The shard names its epoch; the command is idempotent, so resubmitting under it is safe.
        Effect.flatMap((response) => {
          if (!matchesShard(response)) return Effect.fail(wrongShard())
          if (keyText(response) !== keyText(command)) {
            return Effect.fail(
              new ShardError({
                reason: "out_of_range",
                message: "Submit response names a different command"
              })
            )
          }
          return response._tag === "StaleEpoch" ? submit(command, response.epoch) : Effect.succeed(response)
        })
      )

    const push: Effect.Effect<ReadonlyArray<SubmitResponse>, ShardError | TE> = Effect.gen(function*() {
      const { epoch, outbox } = yield* store.load
      const answers: Array<SubmitResponse> = []
      for (const command of outbox) answers.push(yield* submit(command, epoch))
      // Every command is answered: only now leave the outbox. A retry after a failure part way resubmits them all.
      const answered = new Set(outbox.map(keyText))
      yield* save((state) => {
        const pending = new Set(state.outbox.map(keyText))
        const failures = answers.flatMap((answer): ReadonlyArray<TerminalFailure> => {
          if ((answer._tag !== "Refused" && answer._tag !== "IdempotencyConflict") || !pending.has(keyText(answer))) {
            return []
          }
          const { shard: _, ...failure } = answer
          return [failure]
        })
        return {
          ...state,
          outbox: state.outbox.filter((command) => !answered.has(keyText(command))),
          ...(failures.length === 0 ? {} : { terminalFailures: [...(state.terminalFailures ?? []), ...failures] })
        }
      })
      return answers
    })

    const pull: Effect.Effect<ShardPosition, ShardError | E | TE> = Effect.gen(function*() {
      while (true) {
        const { applied, epoch } = yield* store.load
        const response = yield* transport.pull({ version: protocolVersion, shard, epoch, after: applied, limit })
        if (response.shard !== shard) return yield* wrongShard()
        if (response._tag === "Resync") {
          const snapshot = yield* transport.snapshot(shard)
          if (snapshot.position.shard !== shard) return yield* wrongShard()
          yield* options.apply({ _tag: "Reset", snapshot })
          yield* save((state) => ({ ...state, epoch: snapshot.position.epoch, applied: snapshot.position.seq }))
          continue
        }
        const through = { shard, epoch: response.epoch, seq: response.through }
        if (response.entries.length > 0) yield* options.apply({ _tag: "Entries", entries: response.entries, through })
        yield* save((state) => ({ ...state, applied: response.through }))
        if (response.done) return through
      }
    })

    return {
      enqueue: (stream, payload) =>
        lock.withPermit(modify((state) => {
          const command: Command = { key: [options.node, String(state.nextCommand)], stream, payload }
          return [command, {
            ...state,
            nextCommand: state.nextCommand + 1,
            outbox: [...state.outbox, command]
          }] as const
        })),
      push: lock.withPermit(push),
      pull: lock.withPermit(pull),
      sync: lock.withPermit(Effect.andThen(push, pull)),
      state: store.load
    }
  })
