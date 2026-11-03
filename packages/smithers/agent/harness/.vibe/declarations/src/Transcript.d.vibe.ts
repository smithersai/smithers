/**
 * Transcript projection from durable journal entries.
 *
 * The transcript grows: what the model saw is what it said plus what the
 * harness answered, in journal order. A `continue` used to be able to replace
 * the whole projection with a list of messages the cell had written for its
 * successor, and that branch is gone with the surface that produced it — a
 * journal from those waves still decodes, and its `context` entries are simply
 * not read.
 *
 * @since 0.1.0
 */
import type { JournalEvent } from "@smthrs/journal";
import { ModelRequest } from "@smthrs/model";
import { Result, Schema } from "effect";
import * as AgentEvent from "../../../src/AgentEvent.ts";
import type * as Cell from "../../../src/Cell.ts";
import type * as EngineLike from "../../../src/EngineLike.ts";
import { HarnessError } from "../../../src/HarnessError.ts";
/**
 * Journal and model-key format after summaries became user context.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const journalVersion = 2;
/**
 * The event-type namespace a session journals its controller events under.
 *
 * Resume validation reads only the entries under this prefix, and the writer
 * that produces them lives in another package, so the prefix is exported here
 * rather than spelled twice: a writer types its event types as
 * {@link ControlEventType} and a rename fails to compile instead of silently
 * emptying the set {@link validateJournal} inspects.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export declare const controlEventPrefix = "control.agent.";
/**
 * An event type {@link validateJournal} validates.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ControlEventType = `${typeof controlEventPrefix}${string}`;
/**
 * Refuses history whose replay could address different sealed model steps.
 * Historical display projection is separate from permission to resume.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export declare const validateJournal: (entries: ReadonlyArray<JournalEvent.Entry>) => Result.Result<void, HarnessError>;
/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export declare const TranscriptErrorCode: Schema.Literals<readonly ["projection_failed"]>;
/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type TranscriptErrorCode = typeof TranscriptErrorCode.Type;
declare const TranscriptError_base: Schema.Class<TranscriptError, Schema.TaggedStruct<"flows/harness/TranscriptError", {
    readonly code: Schema.Literals<readonly ["projection_failed"]>;
    readonly message: Schema.String;
    readonly cause: Schema.optional<Schema.Defect>;
}>, import("effect/Cause").YieldableError>;
/**
 * Stable failures produced while projecting a durable transcript.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export declare class TranscriptError extends TranscriptError_base {
}
/**
 * The kind and message of one projected transcript item.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ProjectedMessage {
    readonly kind: "transcript" | "summary" | "steering";
    readonly message: ModelRequest.Message;
}
/**
 * A projection with the compaction replacement identity, when one was recorded.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ProjectedState {
    readonly messages: ReadonlyArray<ProjectedMessage>;
    readonly replaced?: string | undefined;
    readonly cell: CellEvidence;
}
/**
 * Schema-decoded cell evidence consumed while rebuilding a journal.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface CellEvidence {
    readonly produced: ReadonlyArray<Cell.Source>;
    /**
     * What each frame printed, in journal order.
     *
     * The print buffer is the whole of the context channel: it is what the NEXT
     * model turn reads, and `AgentEvent.CellPrinted` is journaled rather than
     * derived precisely so a projection can rebuild that window without
     * re-running anything. It was missing from this decoder, so a transcript
     * projected from a harness-native journal could not reconstruct what the
     * model saw.
     */
    readonly printed: ReadonlyArray<AgentEvent.CellPrinted>;
    readonly callsStarted: ReadonlyArray<Cell.Call>;
    readonly callsSettled: ReadonlyArray<AgentEvent.CellCallSettled>;
    readonly settled: ReadonlyArray<AgentEvent.CellSettled>;
    readonly transitions: ReadonlyArray<Cell.Transition>;
    readonly suspensions: ReadonlyArray<EngineLike.SuspendReason>;
    readonly aborts: ReadonlyArray<string>;
}
/**
 * Projects journal events into their model-visible transcript state as typed
 * data, preserving malformed payload failures instead of throwing.
 *
 * This rebuilds turn structure, the settlement's own message, and every
 * journaled controller demand. The controller also folds frame-local
 * settled-call salvage and the memory-probe alert into failure notes. A raised
 * cell's `bindingPathMiss` hint is live-only, so the projection rebuilds a
 * shorter note exactly where that hint would name a missed binding.
 *
 * A terminal frame has the opposite skew: `observe` appends no observation
 * once the frame budget is spent, while this projection rebuilds its journaled
 * print and settlement. On a run whose last frame was terminal, it therefore
 * over-reports by one trailing user turn. `AgentEvent.TurnClosed.outcome` is the
 * journaled signal a future projection would key on to drop it: `"resolved"`
 * on the terminal frame and `"continue"` otherwise.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export declare const projectStateResult: (entries: ReadonlyArray<JournalEvent.Entry>) => Result.Result<ProjectedState, TranscriptError>;
/**
 * Projects model-visible messages in canonical journal sequence order.
 *
 * @category projections
 * @since 0.1.0
 * @slop
 */
export declare const projectResult: (entries: ReadonlyArray<JournalEvent.Entry>) => Result.Result<ReadonlyArray<ModelRequest.Message>, TranscriptError>;
/**
 * Pure external-source decoders; never create executable journal identities.
 * @since 1.0.0-rc.1
 */
export { decodeClaude, decodeCodex } from "../../../src/ExternalTranscript.ts";
export type { Decoded as ExternalDecoded, Entry as ExternalEntry } from "../../../src/ExternalTranscript.ts";
