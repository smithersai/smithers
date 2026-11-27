/**
 * Person-private message pin state and pure LWW reducer for Durable Object SQLite shards (ADR 0170).
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"

/**
 * Canonical lowercase UUID pattern shared across Postgres and person-private SQLite pin shards.
 * Enforcing lowercase prevents duplicate entries for the same conversation across case variants.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const isUUID = (value: string): boolean => UUID_PATTERN.test(value)

/**
 * Schema for one conversation's current pin state for a single person.
 * `messageId === null` is a tombstone recording that the pin was explicitly cleared at `atMs`,
 * so older out-of-order pin writes cannot resurrect a cleared pin.
 *
 * @since 1.0.0
 * @category models
 */
export const PinEntry = Schema.Struct({
  conversationId: Schema.String.check(Schema.makeFilter(isUUID)),
  personId: Schema.NonEmptyString,
  messageId: Schema.NullOr(Schema.String.check(Schema.makeFilter(isUUID))),
  changedAt: Schema.NonEmptyString,
  atMs: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  hubSeq: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
})
/**
 * Type definition for `PinEntry`.
 *
 * @since 1.0.0
 * @category models
 */
export type PinEntry = typeof PinEntry.Type

/**
 * Canonical projection of one person's message pins across all conversations,
 * ordered by `conversationId` so `canonicalHash` is deterministic across devices and replays.
 *
 * @since 1.0.0
 * @category models
 */
export const Pins = Schema.Struct({
  entries: Schema.Array(PinEntry)
})
/**
 * Type definition for `Pins`.
 *
 * @since 1.0.0
 * @category models
 */
export type Pins = typeof Pins.Type

/**
 * Empty pin projection for a person with no recorded pins yet.
 *
 * @since 1.0.0
 * @category models
 */
export const emptyPins: Pins = { entries: [] }

/**
 * Command setting or clearing a person's pinned message in a conversation.
 *
 * @since 1.0.0
 * @category models
 */
export const SetPin = Schema.Struct({
  _tag: Schema.Literal("SetPin"),
  conversationId: Schema.String.check(Schema.makeFilter(isUUID)),
  personId: Schema.NonEmptyString,
  messageId: Schema.NullOr(Schema.String.check(Schema.makeFilter(isUUID))),
  changedAt: Schema.NonEmptyString,
  atMs: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
})
/**
 * Type definition for `SetPin`.
 *
 * @since 1.0.0
 * @category models
 */
export type SetPin = typeof SetPin.Type

/**
 * Union of commands accepted by a person-private pins shard.
 *
 * @since 1.0.0
 * @category models
 */
export const PinCommand = SetPin
/**
 * Type definition for `PinCommand`.
 *
 * @since 1.0.0
 * @category models
 */
export type PinCommand = typeof PinCommand.Type

/**
 * Event committed to a person-private pins shard when a pin is set or cleared.
 *
 * @since 1.0.0
 * @category models
 */
export const PinSet = Schema.Struct({
  _tag: Schema.Literal("PinSet"),
  conversationId: Schema.String.check(Schema.makeFilter(isUUID)),
  personId: Schema.NonEmptyString,
  messageId: Schema.NullOr(Schema.String.check(Schema.makeFilter(isUUID))),
  changedAt: Schema.NonEmptyString,
  atMs: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
})
/**
 * Type definition for `PinSet`.
 *
 * @since 1.0.0
 * @category models
 */
export type PinSet = typeof PinSet.Type

/**
 * Union of events emitted by a person-private pins shard.
 *
 * @since 1.0.0
 * @category models
 */
export const PinEvent = PinSet
/**
 * Type definition for `PinEvent`.
 *
 * @since 1.0.0
 * @category models
 */
export type PinEvent = typeof PinEvent.Type

/**
 * Pure decision result returned by {@link decidePin}.
 *
 * @since 1.0.0
 * @category models
 */
export type PinDecision =
  | { readonly _tag: "Accepted"; readonly events: ReadonlyArray<PinEvent> }
  | { readonly _tag: "Refused"; readonly reason: "wrong_person" | "stale_pin" }

/**
 * Looks up the current pin entry for `conversationId`, or `undefined` if never pinned.
 *
 * @since 1.0.0
 * @category queries
 */
export const findPin = (state: Pins, conversationId: string): PinEntry | undefined =>
  state.entries.find((entry) => entry.conversationId === conversationId)

/**
 * Pure LWW decision function for a person-private pins shard.
 * Enforces optional person ownership (`command.personId === expectedPersonId`) and monotonic `atMs`
 * per conversation (exact replays at the same `atMs` produce an idempotent empty event list;
 * conflicting writes at equal or older `atMs` are refused as `stale_pin` so ties are deterministic
 * first-arrival-wins across replays).
 *
 * @since 1.0.0
 * @category reducers
 */
export const decidePin = (state: Pins, command: PinCommand, expectedPersonId?: string): PinDecision => {
  if (expectedPersonId !== undefined && command.personId !== expectedPersonId) {
    return { _tag: "Refused", reason: "wrong_person" }
  }
  const existing = findPin(state, command.conversationId)
  if (existing !== undefined) {
    if (
      command.atMs === existing.atMs &&
      command.messageId === existing.messageId &&
      command.changedAt === existing.changedAt
    ) {
      return { _tag: "Accepted", events: [] }
    }
    if (command.atMs <= existing.atMs) {
      return { _tag: "Refused", reason: "stale_pin" }
    }
  }
  return {
    _tag: "Accepted",
    events: [
      {
        _tag: "PinSet",
        conversationId: command.conversationId,
        personId: command.personId,
        messageId: command.messageId,
        changedAt: command.changedAt,
        atMs: command.atMs
      }
    ]
  }
}

/**
 * Pure state transition folding one committed {@link PinEvent} at `hubSeq` into {@link Pins},
 * maintaining deterministic `conversationId` order.
 *
 * @since 1.0.0
 * @category reducers
 */
export const evolvePin = (state: Pins, event: PinEvent, hubSeq: number): Pins => {
  const nextEntry: PinEntry = {
    conversationId: event.conversationId,
    personId: event.personId,
    messageId: event.messageId,
    changedAt: event.changedAt,
    atMs: event.atMs,
    hubSeq
  }
  const filtered = state.entries.filter((entry) => entry.conversationId !== event.conversationId)
  filtered.push(nextEntry)
  filtered.sort((a, b) => (a.conversationId < b.conversationId ? -1 : 1))
  return { entries: filtered }
}
