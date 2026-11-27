/**
 * The reference machine and the shard sync envelope.
 *
 * `decide` and `evolve` are the pure domain machine. `submit` is the shard
 * authority's admission step (generation fence, receipt ledger, gapless
 * `hubSeq`). `applyCommit` is a replica's apply step. `rebasePending` replays a
 * local outbox over a confirmed state.
 *
 * Mirrors `lean/smithers-state/SmithersState/{Machine,Sync}.lean`. No IO, no
 * clock, no Effect runtime: every export is a total function of its arguments.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import { canonicalHash, canonicalJson } from "./Canonical.ts"
import { Chat, ChatCommand, ChatEvent, type ChatRefusal, decideChat, emptyChat, evolveChat } from "./Chat.ts"
import type { Decision } from "./Decision.ts"
import {
  decidePlan,
  emptyPlanTree,
  evolvePlan,
  PlanCommand,
  PlanEvent,
  type PlanRefusal,
  PlanTree
} from "./PlanTree.ts"

/**
 * Schema or value export `AppState` (app state).
 *
 * @since 1.0.0
 * @category schemas
 */
export const AppState = Schema.Struct({ plan: PlanTree, chat: Chat })
/**
 * Type definition for `AppState` (app state).
 *
 * @since 1.0.0
 * @category models
 */
export type AppState = typeof AppState.Type

/**
 * Initial state value `initialAppState` (initial app state).
 *
 * @since 1.0.0
 * @category constants
 */
export const initialAppState: AppState = { plan: emptyPlanTree, chat: emptyChat }

/**
 * Schema or value export `Command` (command).
 *
 * @since 1.0.0
 * @category schemas
 */
export const Command = Schema.Union([...PlanCommand.members, ...ChatCommand.members])
/**
 * Type definition for `Command` (command).
 *
 * @since 1.0.0
 * @category models
 */
export type Command = typeof Command.Type

/**
 * Schema or value export `DomainEvent` (domain event).
 *
 * @since 1.0.0
 * @category schemas
 */
export const DomainEvent = Schema.Union([...PlanEvent.members, ...ChatEvent.members])
/**
 * Type definition for `DomainEvent` (domain event).
 *
 * @since 1.0.0
 * @category models
 */
export type DomainEvent = typeof DomainEvent.Type

/**
 * Type definition for `Refusal` (refusal).
 *
 * @since 1.0.0
 * @category models
 */
export type Refusal = PlanRefusal | ChatRefusal

/**
 * A sequenced event: what the authority appends to its log and what `evolve`
 * consumes. `hubSeq` is 0 only for optimistic local application.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Commit = Schema.Struct({
  hubSeq: Schema.Int,
  epoch: Schema.Int,
  origin: Schema.String,
  commandId: Schema.String,
  event: DomainEvent
})
/**
 * Type definition for `Commit` (commit).
 *
 * @since 1.0.0
 * @category models
 */
export type Commit = typeof Commit.Type

/**
 * Pure state-machine helper `decide` (decide).
 *
 * @since 1.0.0
 * @category utilities
 */
export const decide = (state: AppState, command: Command): Decision<DomainEvent, Refusal> => {
  switch (command._tag) {
    case "PostMessage":
    case "UpdateMessageStatus":
    case "UpdateMessageMetadata":
    case "UpdateMessageBody":
      return decideChat(state.chat, command)
    default:
      return decidePlan(state.plan, command)
  }
}

/**
 * Pure state-machine helper `evolve` (evolve).
 *
 * @since 1.0.0
 * @category utilities
 */
export const evolve = (state: AppState, commit: Commit): AppState => {
  const event = commit.event
  switch (event._tag) {
    case "MessagePosted":
    case "MessageStatusUpdated":
    case "MessageMetadataUpdated":
    case "MessageBodyUpdated":
      return { plan: state.plan, chat: evolveChat(state.chat, commit.hubSeq, event) }
    default:
      return { plan: evolvePlan(state.plan, event), chat: state.chat }
  }
}

/**
 * Apply events that the hub has not sequenced yet. They carry `hubSeq` 0.
 *
 * @since 1.0.0
 * @category utilities
 */
export const applyOptimistic = (state: AppState, events: ReadonlyArray<DomainEvent>): AppState =>
  events.reduce<AppState>(
    (current, event) => evolve(current, { hubSeq: 0, epoch: 0, origin: "", commandId: "", event }),
    state
  )

/**
 * Type definition for `Rebased` (rebased).
 *
 * @since 1.0.0
 * @category models
 */
export interface Rebased {
  readonly state: AppState
  /** One decision per pending command, in order. */
  readonly decisions: ReadonlyArray<Decision<DomainEvent, Refusal>>
}

/**
 * Replay pending commands over a confirmed state. A refused command leaves the
 * state unchanged; the caller reads `decisions` to drop or surface it.
 *
 * @since 1.0.0
 * @category utilities
 */
export const rebasePending = (confirmed: AppState, pending: ReadonlyArray<Command>): Rebased => {
  let state = confirmed
  const decisions: Array<Decision<DomainEvent, Refusal>> = []
  for (const command of pending) {
    const decision = decide(state, command)
    if (decision._tag === "Accepted") state = applyOptimistic(state, decision.events)
    decisions.push(decision)
  }
  return { state, decisions }
}

/**
 * A command on the wire: the generation the sender believes in, plus its idempotency key.
 *
 * @since 1.0.0
 * @category schemas
 */
export const Envelope = Schema.Struct({
  epoch: Schema.Int,
  origin: Schema.String,
  commandId: Schema.String,
  command: Command
})
/**
 * Type definition for `Envelope` (envelope).
 *
 * @since 1.0.0
 * @category models
 */
export type Envelope = typeof Envelope.Type

/**
 * Schema or value export `Receipt` (receipt).
 *
 * @since 1.0.0
 * @category schemas
 */
export const Receipt = Schema.Struct({
  origin: Schema.String,
  commandId: Schema.String,
  command: Command,
  firstSeq: Schema.Int,
  count: Schema.Int
})
/**
 * Type definition for `Receipt` (receipt).
 *
 * @since 1.0.0
 * @category models
 */
export type Receipt = typeof Receipt.Type

/**
 * Schema or value export `ShardState` (shard state).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ShardState = Schema.Struct({
  epoch: Schema.Int,
  headSeq: Schema.Int,
  state: AppState,
  receipts: Schema.Record(Schema.String, Receipt),
  log: Schema.Array(Commit)
})
/**
 * Type definition for `ShardState` (shard state).
 *
 * @since 1.0.0
 * @category models
 */
export type ShardState = typeof ShardState.Type

/**
 * Initial state value `initialShardState` (initial shard state).
 *
 * @since 1.0.0
 * @category constants
 */
export const initialShardState: ShardState = {
  epoch: 0,
  headSeq: 0,
  state: initialAppState,
  receipts: {},
  log: []
}

/**
 * Collision-free ledger key for `(originNodeId, commandId)`.
 *
 * @since 1.0.0
 * @category utilities
 */
export const receiptKey = (origin: string, commandId: string): string => JSON.stringify([origin, commandId])

/**
 * Type definition for `SubmitResult` (submit result).
 *
 * @since 1.0.0
 * @category models
 */
export type SubmitResult =
  | { readonly _tag: "Accepted"; readonly firstSeq: number; readonly count: number }
  | { readonly _tag: "Duplicate"; readonly firstSeq: number; readonly count: number }
  | { readonly _tag: "Refused"; readonly reason: Refusal | "idempotency_conflict" }
  | { readonly _tag: "EpochMismatch"; readonly current: number }

/**
 * Type definition for `Submitted` (submitted).
 *
 * @since 1.0.0
 * @category models
 */
export interface Submitted {
  readonly state: ShardState
  readonly result: SubmitResult
}

/**
 * The authority's admission step. Order of checks: generation fence, receipt
 * ledger, `decide`. Only `Accepted` changes the shard.
 *
 * @since 1.0.0
 * @category utilities
 */
export const submit = (shard: ShardState, envelope: Envelope): Submitted => {
  if (envelope.epoch !== shard.epoch) {
    return { state: shard, result: { _tag: "EpochMismatch", current: shard.epoch } }
  }
  const key = receiptKey(envelope.origin, envelope.commandId)
  // Snapshot at admission: the receipt, the log, and the state must never alias
  // caller-owned data, or a later producer edit would rewrite duplicate
  // detection and the canonical hash.
  const command: Command = structuredClone(envelope.command)
  if (Object.hasOwn(shard.receipts, key)) {
    const receipt = shard.receipts[key]!
    return canonicalJson(receipt.command) === canonicalJson(command)
      ? { state: shard, result: { _tag: "Duplicate", firstSeq: receipt.firstSeq, count: receipt.count } }
      : { state: shard, result: { _tag: "Refused", reason: "idempotency_conflict" } }
  }
  const decision = decide(shard.state, command)
  if (decision._tag === "Refused") {
    return { state: shard, result: { _tag: "Refused", reason: decision.reason } }
  }
  const firstSeq = shard.headSeq + 1
  const commits: ReadonlyArray<Commit> = decision.events.map((event, index) => ({
    hubSeq: firstSeq + index,
    epoch: shard.epoch,
    origin: envelope.origin,
    commandId: envelope.commandId,
    event
  }))
  return {
    state: {
      epoch: shard.epoch,
      headSeq: shard.headSeq + commits.length,
      state: commits.reduce(evolve, shard.state),
      receipts: {
        ...shard.receipts,
        [key]: {
          origin: envelope.origin,
          commandId: envelope.commandId,
          command,
          firstSeq,
          count: commits.length
        }
      },
      log: [...shard.log, ...commits]
    },
    result: { _tag: "Accepted", firstSeq, count: commits.length }
  }
}

/**
 * A new generation of the authority. It fences every writer still on the old one.
 *
 * @since 1.0.0
 * @category utilities
 */
export const bumpEpoch = (shard: ShardState): ShardState => ({ ...shard, epoch: shard.epoch + 1 })

/**
 * Schema or value export `Replica` (replica).
 *
 * @since 1.0.0
 * @category schemas
 */
export const Replica = Schema.Struct({
  epoch: Schema.Int,
  cursor: Schema.Int,
  confirmed: AppState
})
/**
 * Type definition for `Replica` (replica).
 *
 * @since 1.0.0
 * @category models
 */
export type Replica = typeof Replica.Type

/**
 * Initial state value `initialReplica` (initial replica).
 *
 * @since 1.0.0
 * @category constants
 */
export const initialReplica: Replica = { epoch: 0, cursor: 0, confirmed: initialAppState }

/**
 * Type definition for `ApplyResult` (apply result).
 *
 * @since 1.0.0
 * @category models
 */
export type ApplyResult = "Applied" | "Duplicate" | "Gap" | "StaleEpoch" | "EpochAhead"

/**
 * Type definition for `Applied` (applied).
 *
 * @since 1.0.0
 * @category models
 */
export interface Applied {
  readonly replica: Replica
  readonly result: ApplyResult
}

/**
 * A replica applies one commit: strictly in order, never from another generation.
 *
 * @since 1.0.0
 * @category utilities
 */
export const applyCommit = (replica: Replica, commit: Commit): Applied => {
  if (commit.epoch < replica.epoch) return { replica, result: "StaleEpoch" }
  if (replica.epoch < commit.epoch) return { replica, result: "EpochAhead" }
  if (commit.hubSeq <= replica.cursor) return { replica, result: "Duplicate" }
  if (commit.hubSeq === replica.cursor + 1) {
    return {
      replica: { epoch: replica.epoch, cursor: commit.hubSeq, confirmed: evolve(replica.confirmed, commit) },
      result: "Applied"
    }
  }
  return { replica, result: "Gap" }
}

/**
 * Pure state-machine helper `applyAll` (apply all).
 *
 * @since 1.0.0
 * @category utilities
 */
export const applyAll = (replica: Replica, commits: ReadonlyArray<Commit>): Replica =>
  commits.reduce((current, commit) => applyCommit(current, commit).replica, replica)

/**
 * Resync: adopt a newer generation from a snapshot. An older or equal one is ignored.
 *
 * @since 1.0.0
 * @category utilities
 */
export const installSnapshot = (replica: Replica, epoch: number, seq: number, state: AppState): Replica =>
  replica.epoch < epoch ? { epoch, cursor: seq, confirmed: state } : replica

/**
 * The Gate 1 `ReferenceMachine` contract, instantiated.
 *
 * @since 1.0.0
 * @category utilities
 */
export const referenceMachine = {
  initial: initialAppState,
  decide,
  evolve,
  canonicalHash: (state: AppState): string => canonicalHash(state)
} as const
