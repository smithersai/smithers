/**
 * The run diagnosis: what happened to a run, computed from its own control
 * events.
 *
 * The old gateway answered this question with a `whatHappened` RPC that read
 * run rows, node-iteration rows, and attempt rows out of the engine database
 * and optionally asked an agent to narrate them. The rc.0 gateway serves the
 * same answer as a field of the `run-summary` projection, computed from the
 * ordered `ControlEvent` deltas `Control.watch` already publishes. Nothing
 * here opens a database, so a diagnosis read through a relay is the same
 * diagnosis a local reader computes.
 *
 * This is the one fold both surfaces read. `@smthrs/cli` `Forensics` calls
 * `digest` and adds what a terminal card needs on top of it: duplicate calls,
 * per-flow counts, the parked approval payload, and the declined-launch state
 * the wire vocabulary does not carry. The counts, the refusal aggregation, and
 * the clipping are therefore one implementation, not two that drift.
 *
 * @since 1.0.0
 */
import { ControlSchema } from "@smthrs/control";
import * as Fault from "@smthrs/flow/Fault";
import { uniqueCallEvents } from "./internal/callEvents.vibe";
import * as NativeResolution from "../../../src/internal/nativeResolution.ts";
/**
 * Keeps one start and settlement per durable call identity, preferring a
 * committed native fact over telemetry at the first observation's position.
 * Unidentified legacy events remain distinct because their identity cannot
 * be recovered from flow names and inputs. Shared with CLI call counts.
 *
 * @since 1.0.0
 * @category projections
 */
export { uniqueCallEvents };
/**
 * Native fact normalization and stable call/checkpoint identities.
 * Incremental readers retain these keys to match the full history fold.
 *
 * @since 1.0.0
 * @category projections
 */
export { callEventKey, callScope, nativeCallEvent, nativeStepEvent } from "./internal/callEvents.vibe";
/**
 * Finds an open call by ID, with name/FIFO fallback only for legacy starts.
 * Shared by gateway node output and the CLI's compatible flow/ordinal IDs.
 *
 * @since 1.0.0
 * @category projections
 */
export { openCallIndex } from "./internal/callEvents.vibe";
/**
 * The run statuses a digest may report.
 *
 * `@smthrs/control` `ControlSchema.RunStatus` is the vocabulary; this is the
 * runtime set the fold checks a journaled kind against.
 *
 * @since 1.0.0
 * @category models
 */
export type RunStatus = ControlSchema.RunStatus;
/**
 * One refused flow call, aggregated by its refusal message.
 *
 * @since 1.0.0
 * @category models
 */
export interface Refusal {
    readonly message: string;
    readonly count: number;
}
/**
 * Everything the diagnosis computes from one run's events.
 *
 * @since 1.0.0
 * @category models
 */
export interface Digest {
    /** The last run status seen, or undefined before launch. */
    readonly status: RunStatus | undefined;
    /** The journaled failure cause, when the run failed and recorded one. */
    readonly cause: string | undefined;
    /** The typed fault stamped beside {@link cause}; it is written and cleared with it. */
    readonly fault?: Fault.Fault | undefined;
    /** The model seat the last opened turn ran on. */
    readonly seat: string | undefined;
    readonly turns: number;
    readonly calls: number;
    readonly callsFailed: number;
    readonly editsAttempted: number;
    readonly editsSucceeded: number;
    /** Refusal messages, descending by count. */
    readonly refusals: ReadonlyArray<Refusal>;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** USD the run's priced model calls cost; zero when none was priced. */
    readonly costUsd: number;
    /** The final assistant output, when the run resolved. */
    readonly finalOutput: string | undefined;
    /** Root binding and committed native result, retained across bounded windows. */
    readonly nativeResolution?: NativeResolution.NativeResolution | undefined;
    /** The pending ask's question, when the run parked for approval. */
    readonly parkedQuestion: string | undefined;
    /** The earliest time a kind this fold handles occurred at. */
    readonly startedAt: number | undefined;
    /** The latest time a kind this fold handles occurred at. */
    readonly endedAt: number | undefined;
}
/**
 * Reads a payload as a record. Wire payloads are `Json`, so every field read
 * tolerates absence and the digest of a malformed journal is a sparse digest,
 * never a throw.
 *
 * @param value the payload to read
 * @since 1.0.0
 * @category conversions
 */
export declare const asRecord: (value: unknown) => Record<string, unknown>;
/**
 * Reads a payload field as a string, or nothing when it is not one.
 *
 * @param value the field to read
 * @since 1.0.0
 * @category conversions
 */
export declare const asString: (value: unknown) => string | undefined;
/**
 * Reads a payload field as a number, or nothing when it is not one.
 *
 * @param value the field to read
 * @since 1.0.0
 * @category conversions
 */
export declare const asNumber: (value: unknown) => number | undefined;
/**
 * Occurrence time: the payload's own stamp, else journal admission time.
 *
 * @param event the event to time
 * @since 1.0.0
 * @category conversions
 */
export declare const timeOf: (event: ControlSchema.ControlEvent) => number;
/**
 * The first line, whichever line ending produced it. Splitting on `\n` alone
 * left the `\r` of a CRLF cause on the wire, and every reader of a one-line
 * field, here and in `@smthrs/cli` `Forensics`, wants the same answer.
 *
 * @param text the text to read one line of
 * @since 1.0.0
 * @category conversions
 */
export declare const firstLine: (text: string) => string;
/**
 * Truncates to a display width, marking the cut.
 *
 * The cut is made on code points, never on UTF-16 code units. Slicing code
 * units splits an astral character in half and puts a lone surrogate on the
 * wire, where a Go decoder silently replaces it with U+FFFD and a strict
 * decoder rejects the whole frame; the result of this function is always well
 * formed. A clipped result is exactly `width` code points, so `width` 1 is the
 * ellipsis alone and `width` 0, or any negative width, is the empty string.
 *
 * @param text the text to clip
 * @param width the greatest number of code points to keep
 * @since 1.0.0
 * @category rendering
 */
export declare const clip: (text: string, width: number) => string;
/**
 * The kinds this fold handles, with the class each one's fields belong to.
 *
 * Exported so a test can hold the table above against the map rather than
 * trusting a comment, and so a new handler that names no class fails both the
 * compiler and that test.
 *
 * @since 1.0.0
 * @category models
 */
export declare const handlerReach: Readonly<Record<string, "aggregate" | "root">>;
/**
 * A `control.run.*` verdict stamped with a run id other than `runId`, such as
 * a child's riding in the parent's events. It must not set the digested run's
 * status or failure cause. An unstamped verdict is the run's own.
 *
 * @param event the event to classify
 * @param runId the run being digested; omitted, no verdict is foreign
 * @category predicates
 * @since 1.0.0
 */
export declare const foreignVerdict: (event: ControlSchema.ControlEvent, runId: string | undefined) => boolean;
/**
 * Folds one event range, retaining compact identities for later combination.
 * Native facts supersede telemetry at its first position across ranges too.
 *
 * @param events the range to fold
 * @param runId the run being digested; a `control.run.*` verdict stamped with
 *   another run's id is skipped. Omitted, every verdict folds.
 * @category constructors
 * @since 1.0.0
 */
export declare const digest: (events: ReadonlyArray<ControlSchema.ControlEvent>, runId?: string) => Digest;
/**
 * The wall-clock span the events cover, rendered for a reader.
 *
 * Only the span is read, so a caller carrying a wider digest of its own, as
 * `@smthrs/cli` `Forensics` does, measures it with this rather than a copy.
 *
 * @param value the span to measure
 * @since 1.0.0
 * @category rendering
 */
export declare const duration: (value: Pick<Digest, "startedAt" | "endedAt">) => string;
/**
 * A USD amount for a reader: cents from one dollar, four places below it, so
 * a cheap run never reads as `$0.00`.
 *
 * @param value dollars, finite and non-negative
 * @since 1.0.0
 * @category rendering
 */
export declare const usd: (value: number) => string;
/**
 * Assistant text, or a typed module's committed result under its bound root.
 * @category projections
 * @since 1.0.0
 */
export declare const resolvedOutput: (value: Pick<Digest, "finalOutput" | "nativeResolution">) => string | undefined;
/**
 * The one-line verdict: the status plus the reason that most explains it.
 *
 * Priority order mirrors what a reader needs first: a recorded failure cause,
 * then a park's question, then the "worked but never edited" pathology a green
 * status would otherwise hide, then the resolved output.
 *
 * @param value the digest to judge
 * @since 1.0.0
 * @category rendering
 */
export declare const verdict: (value: Digest) => string;
/**
 * Identity a diagnosis is rendered for.
 *
 * @since 1.0.0
 * @category models
 */
export interface Subject {
    readonly runId: string;
    readonly flowId?: string | undefined;
}
/**
 * Renders the diagnosis card for one run: verdict, activity evidence, tokens,
 * cost when any call was priced, refusals, cause, and output.
 *
 * @param subject the run being diagnosed
 * @param value the digest computed from its events
 * @since 1.0.0
 * @category rendering
 */
export declare const render: (subject: Subject, value: Digest) => string;
/**
 * A digest of no events at all: the identity {@link combine} folds onto.
 *
 * @since 1.0.0
 * @category constructors
 */
export declare const emptyDigest: () => Digest;
/**
 * Combines adjacent digests without counting an identified call or checkpoint
 * twice. A later native fact replaces the earlier telemetry contribution.
 * Identity state is private and must stay with the in-memory digest; a plain
 * reconstructed Digest is treated as an already aggregated, unkeyed value.
 * @category constructors
 * @since 1.0.0
 */
export declare const combine: (earlier: Digest, later: Digest) => Digest;
