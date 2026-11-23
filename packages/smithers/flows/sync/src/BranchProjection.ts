/**
 * The branch document projection: journal entries folded into what two people
 * looking at the same branch must agree on.
 *
 * The fold is order-independent over the canonical entry set, which is what
 * makes convergence a property rather than a hope: any two clients that have
 * applied the same set of entries hold the same state, regardless of the
 * order their transports delivered frames in or how many times a frame
 * arrived.
 *
 * Three guards do all the work, and each is a production invariant:
 *
 * - entries from another branch's run are ignored, so a mis-routed frame can
 *   never leak into a projection;
 * - an entry already folded — the cursor tip redelivered, or a command id
 *   already applied — is ignored, so an at-least-once transport cannot
 *   double-apply a user action and a reconnect replays no side effects;
 * - an entry below the cursor whose command was never applied is folded into
 *   its canonical `seq` position, so out-of-order delivery converges on the
 *   same document instead of permanently dropping the late entry.
 *
 * @since 0.1.0
 */

import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as HashSet from "effect/HashSet"
import * as Schema from "effect/Schema"
import { BranchId, branchRunId, CommandEvent, CommandId, ParticipantId, SayCommand } from "./BranchProtocol.ts"

/**
 * One collaborative chat message in the branch timeline.
 *
 * @category models
 * @since 0.1.0
 */
export const Message = Schema.Struct({
  seq: JournalEvent.Seq,
  commandId: CommandId,
  participantId: ParticipantId,
  /** The verified share capability that submitted the message. */
  capabilityId: Schema.String,
  text: Schema.String
})
/**
 * The value form of {@link Message}.
 *
 * @category models
 * @since 0.1.0
 */
export type Message = typeof Message.Type

/**
 * One command applied to the branch document.
 *
 * @category models
 * @since 0.1.0
 */
export const AppliedCommand = Schema.Struct({
  seq: JournalEvent.Seq,
  commandId: CommandId,
  participantId: ParticipantId,
  /** The verified share capability that submitted the command. */
  capabilityId: Schema.String,
  name: Schema.NonEmptyString,
  args: Schema.String,
  target: Schema.String
})
/**
 * The value form of {@link AppliedCommand}.
 *
 * @category models
 * @since 0.1.0
 */
export type AppliedCommand = typeof AppliedCommand.Type

/**
 * The current winning value of one durably edited shared field.
 *
 * @category models
 * @since 0.1.0
 */
export const Field = Schema.Struct({
  target: Schema.NonEmptyString,
  value: Schema.String,
  seq: JournalEvent.Seq,
  participantId: ParticipantId,
  /** The verified share capability that wrote the winning value. */
  capabilityId: Schema.String
})
/**
 * The value form of {@link Field}.
 *
 * @category models
 * @since 0.1.0
 */
export type Field = typeof Field.Type

/**
 * The projected state of one branch document.
 *
 * `seq` is the highest journal sequence folded in and is exactly the cursor a
 * client resumes from.
 *
 * @category models
 * @since 0.1.0
 */
export const State = Schema.Struct({
  branchId: BranchId,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  messages: Schema.Array(Message),
  commands: Schema.Array(AppliedCommand),
  fields: Schema.Array(Field)
})
/**
 * The value form of {@link State}.
 *
 * @category models
 * @since 0.1.0
 */
export type State = typeof State.Type

/**
 * The empty projection of a branch, whose cursor is "nothing applied".
 *
 * @category constructors
 * @since 0.1.0
 */
export const empty = (branchId: BranchId): State => ({
  branchId,
  seq: -1,
  messages: [],
  commands: [],
  fields: []
})

/**
 * The conflict policy for two durable edits of the same field.
 *
 * Highest canonical sequence wins. Within a branch the sequence is a total
 * order assigned by the journal, so this is already decisive; the
 * lexicographic `participantId` tie-break exists so the policy stays total if
 * a future deployment ever merges two sequence domains. It is deliberately not
 * wall-clock based — client clocks disagree, and a merge rule that depends on
 * them is not deterministic.
 *
 * @category combinators
 * @since 0.1.0
 */
export const resolveField = (existing: Field | undefined, candidate: Field): Field => {
  if (existing === undefined) return candidate
  if (candidate.seq !== existing.seq) return candidate.seq > existing.seq ? candidate : existing
  return candidate.participantId > existing.participantId ? candidate : existing
}

/**
 * Inserts one item into a sequence-ordered array at its canonical position.
 *
 * Canonical sequences are unique within a run, so an equal-sequence collision
 * is unrepresentable here: dedup happens before insertion.
 */
const insertBySeq = <Item extends { readonly seq: JournalEvent.Seq }>(
  items: ReadonlyArray<Item>,
  item: Item
): Array<Item> => {
  const last = items[items.length - 1]
  if (last === undefined || last.seq <= item.seq) return [...items, item]
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (items[middle]!.seq <= item.seq) low = middle + 1
    else high = middle
  }
  const result = items.slice()
  result.splice(low, 0, item)
  return result
}

// Cache by the immutable command array so cursor-only updates share the index.
// Persistent sets let independent continuations share history without changing
// an older state's deduplication. Restored states build their index on first use.
const commandIds = new WeakMap<ReadonlyArray<AppliedCommand>, HashSet.HashSet<CommandId>>()
const indexCommands = (commands: ReadonlyArray<AppliedCommand>): HashSet.HashSet<CommandId> => {
  const cached = commandIds.get(commands)
  if (cached !== undefined) return cached
  const index = HashSet.fromIterable(commands.map((command) => command.commandId))
  commandIds.set(commands, index)
  return index
}

interface DecodedCommand {
  readonly commandId: CommandId
  readonly participantId: ParticipantId
  readonly name: string
  readonly args: string
  readonly target: string
  readonly capabilityId: string
}

/**
 * Fast structural decoder equivalent to `Schema.decodeUnknownOption(CommandEventPayload)`.
 * Validates every required non-empty string field and applies the exact empty-string
 * defaults for omitted optional keys while rejecting non-string values for present keys.
 */
const decodeCommandFast = (payload: unknown): DecodedCommand | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const commandId = record["commandId"]
  if (typeof commandId !== "string" || commandId.length === 0) return undefined
  const participantId = record["participantId"]
  if (typeof participantId !== "string" || participantId.length === 0) return undefined
  const name = record["name"]
  if (typeof name !== "string" || name.length === 0) return undefined
  let args: string
  if ("args" in record) {
    if (typeof record["args"] !== "string") return undefined
    args = record["args"]
  } else {
    args = ""
  }
  let target: string
  if ("target" in record) {
    if (typeof record["target"] !== "string") return undefined
    target = record["target"]
  } else {
    target = ""
  }
  let capabilityId: string
  if ("capabilityId" in record) {
    if (typeof record["capabilityId"] !== "string") return undefined
    capabilityId = record["capabilityId"]
  } else {
    capabilityId = ""
  }
  return {
    commandId: commandId as CommandId,
    participantId: participantId as ParticipantId,
    name,
    args,
    target,
    capabilityId
  }
}

/**
 * Folds one journal entry into a branch projection.
 *
 * Redelivery and out-of-order delivery are told apart by identity, not by
 * position: the cursor tip redelivered and a command id already applied are
 * no-ops, while a below-cursor entry never applied is folded into canonical
 * order. Non-command entries only raise the cursor, so re-applying one is
 * idempotent by construction.
 *
 * @category combinators
 * @since 0.1.0
 */
export const apply = (state: State, entry: JournalEvent.Entry): State => {
  if (entry.runId !== branchRunId(state.branchId) || entry.seq === state.seq) return state
  const advanced = entry.seq < state.seq ? state : { ...state, seq: entry.seq }
  if (entry.eventType !== CommandEvent) return advanced
  const commandSubmission = decodeCommandFast(entry.payload)
  if (commandSubmission === undefined) return advanced
  const ids = indexCommands(state.commands)
  if (HashSet.has(ids, commandSubmission.commandId)) return advanced
  const command: AppliedCommand = { ...commandSubmission, seq: entry.seq }
  const messages = commandSubmission.name === SayCommand
    ? insertBySeq(state.messages, {
      seq: entry.seq,
      commandId: commandSubmission.commandId,
      participantId: commandSubmission.participantId,
      capabilityId: commandSubmission.capabilityId,
      text: commandSubmission.args
    })
    : state.messages
  const fields = commandSubmission.target === ""
    ? state.fields
    : (() => {
      const candidate: Field = {
        target: commandSubmission.target,
        value: commandSubmission.args,
        seq: entry.seq,
        participantId: commandSubmission.participantId,
        capabilityId: commandSubmission.capabilityId
      }
      const winner = resolveField(
        state.fields.find((field) => field.target === commandSubmission.target),
        candidate
      )
      return [...state.fields.filter((field) => field.target !== commandSubmission.target), winner]
        .sort((left, right) => left.target < right.target ? -1 : 1)
    })()
  const commands = insertBySeq(state.commands, command)
  commandIds.set(commands, HashSet.add(ids, command.commandId))
  return { ...advanced, messages, commands, fields }
}

/**
 * Folds a whole entry stream into a branch projection.
 *
 * @category combinators
 * @since 0.1.0
 */
export const project = (branchId: BranchId, entries: Iterable<JournalEvent.Entry>): State => {
  const runId = branchRunId(branchId)
  let seq = -1
  let lastCommandSeq = -1
  let commandsOrdered = true
  let lastMessageSeq = -1
  let messagesOrdered = true
  const ids = new Set<CommandId>()
  const commands: Array<AppliedCommand> = []
  const messages: Array<Message> = []
  const fields = new Map<string, Field>()
  for (const entry of entries) {
    if (entry.runId !== runId || entry.seq === seq) continue
    if (entry.seq > seq) seq = entry.seq
    if (entry.eventType !== CommandEvent) continue
    const submission = decodeCommandFast(entry.payload)
    if (submission === undefined) continue
    if (ids.has(submission.commandId)) continue
    ids.add(submission.commandId)
    if (entry.seq < lastCommandSeq) commandsOrdered = false
    else lastCommandSeq = entry.seq
    commands.push({
      seq: entry.seq,
      commandId: submission.commandId,
      participantId: submission.participantId,
      capabilityId: submission.capabilityId,
      name: submission.name,
      args: submission.args,
      target: submission.target
    })
    if (submission.name === SayCommand) {
      if (entry.seq < lastMessageSeq) messagesOrdered = false
      else lastMessageSeq = entry.seq
      messages.push({
        seq: entry.seq,
        commandId: submission.commandId,
        participantId: submission.participantId,
        capabilityId: submission.capabilityId,
        text: submission.args
      })
    }
    if (submission.target !== "") {
      const candidate: Field = {
        target: submission.target,
        value: submission.args,
        seq: entry.seq,
        participantId: submission.participantId,
        capabilityId: submission.capabilityId
      }
      fields.set(submission.target, resolveField(fields.get(submission.target), candidate))
    }
  }
  if (!commandsOrdered) commands.sort((left, right) => left.seq - right.seq)
  if (!messagesOrdered) messages.sort((left, right) => left.seq - right.seq)
  return {
    branchId,
    seq,
    commands,
    messages,
    fields: fields.size === 0
      ? []
      : Array.from(fields.values()).sort((left, right) => left.target < right.target ? -1 : 1)
  }
}
