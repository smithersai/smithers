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
import * as JournalEvent from "@smthrs/journal/JournalEvent";
import * as Schema from "effect/Schema";
import { BranchId } from "../../../src/BranchProtocol.ts";
/**
 * One collaborative chat message in the branch timeline.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Message: Schema.Struct<{
    readonly seq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/Seq">;
    readonly commandId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/CommandId">;
    readonly participantId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/ParticipantId">;
    /** The verified share capability that submitted the message. */
    readonly capabilityId: Schema.String;
    readonly text: Schema.String;
}>;
/**
 * The value form of {@link Message}.
 *
 * @category models
 * @since 0.1.0
 */
export type Message = typeof Message.Type;
/**
 * One command applied to the branch document.
 *
 * @category models
 * @since 0.1.0
 */
export declare const AppliedCommand: Schema.Struct<{
    readonly seq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/Seq">;
    readonly commandId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/CommandId">;
    readonly participantId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/ParticipantId">;
    /** The verified share capability that submitted the command. */
    readonly capabilityId: Schema.String;
    readonly name: Schema.NonEmptyString;
    readonly args: Schema.String;
    readonly target: Schema.String;
}>;
/**
 * The value form of {@link AppliedCommand}.
 *
 * @category models
 * @since 0.1.0
 */
export type AppliedCommand = typeof AppliedCommand.Type;
/**
 * The current winning value of one durably edited shared field.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Field: Schema.Struct<{
    readonly target: Schema.NonEmptyString;
    readonly value: Schema.String;
    readonly seq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/Seq">;
    readonly participantId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/ParticipantId">;
    /** The verified share capability that wrote the winning value. */
    readonly capabilityId: Schema.String;
}>;
/**
 * The value form of {@link Field}.
 *
 * @category models
 * @since 0.1.0
 */
export type Field = typeof Field.Type;
/**
 * The projected state of one branch document.
 *
 * `seq` is the highest journal sequence folded in and is exactly the cursor a
 * client resumes from.
 *
 * @category models
 * @since 0.1.0
 */
export declare const State: Schema.Struct<{
    readonly branchId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/BranchId">;
    readonly seq: Schema.Int;
    readonly messages: Schema.$Array<Schema.Struct<{
        readonly seq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/Seq">;
        readonly commandId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/CommandId">;
        readonly participantId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/ParticipantId">;
        /** The verified share capability that submitted the message. */
        readonly capabilityId: Schema.String;
        readonly text: Schema.String;
    }>>;
    readonly commands: Schema.$Array<Schema.Struct<{
        readonly seq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/Seq">;
        readonly commandId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/CommandId">;
        readonly participantId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/ParticipantId">;
        /** The verified share capability that submitted the command. */
        readonly capabilityId: Schema.String;
        readonly name: Schema.NonEmptyString;
        readonly args: Schema.String;
        readonly target: Schema.String;
    }>>;
    readonly fields: Schema.$Array<Schema.Struct<{
        readonly target: Schema.NonEmptyString;
        readonly value: Schema.String;
        readonly seq: Schema.brand<Schema.Int, "@smthrs/journal/JournalEvent/Seq">;
        readonly participantId: Schema.brand<Schema.NonEmptyString, "@smthrs/sync/BranchProtocol/ParticipantId">;
        /** The verified share capability that wrote the winning value. */
        readonly capabilityId: Schema.String;
    }>>;
}>;
/**
 * The value form of {@link State}.
 *
 * @category models
 * @since 0.1.0
 */
export type State = typeof State.Type;
/**
 * The empty projection of a branch, whose cursor is "nothing applied".
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const empty: (branchId: BranchId) => State;
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
export declare const resolveField: (existing: Field | undefined, candidate: Field) => Field;
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
export declare const apply: (state: State, entry: JournalEvent.Entry) => State;
/**
 * Folds a whole entry stream into a branch projection.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const project: (branchId: BranchId, entries: Iterable<JournalEvent.Entry>) => State;
