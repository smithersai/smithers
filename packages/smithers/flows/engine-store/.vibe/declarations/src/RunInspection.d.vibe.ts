/**
 * One run as a person debugging it reads it: what it was given, what it
 * answered, each step it took with its attempts and output, the runs it
 * started, and a page of its journal.
 *
 * `RunInspection` is the display read of the engine's own tables
 * (`flows_runs`, `flows_attempts`, `flows_run_parents` and
 * `flows_journal_events`), never a copy of them. Every value it releases
 * passes through `@smthrs/journal`'s `Redaction.redact` first and is then cut
 * to {@link valueLimitBytes} of UTF-8, so a credential-shaped string never
 * leaves it and a large value costs a reader a known number of bytes. A
 * failure is reduced to a closed code, the failure's tag, so a provider's
 * error text is not released. The one message released is a run's defect, on
 * its `transitioned` decision: the engine wrote it redacted and cut, for an
 * operator to read why the run died.
 *
 * Built with the engine's flows (`layerWith({ flows })`), the reads know each
 * flow's payload and success schemas and, from each flow's plan, each action's
 * success schema. Every value with a known schema is decoded with it and
 * encoded again for display, so a `Schema.Redacted` value at any depth reads
 * as {@link redactedMarker}; one its schema no longer decodes reads as
 * {@link withheldMarker}, never as the stored text. A value whose flow or
 * action is not reachable from those flows, such as an action a body reaches
 * only with its real input, has the redactor's rules alone between it and the
 * reader: return a secret from such a step only inside a field the rules name.
 *
 * {@link Service.payload} is the one read that is not for display: it hands
 * back the run's encoded payload as the engine stored it, so a host can run
 * the same flow again. It belongs inside the engine and never on a wire.
 *
 * Every read runs in one read transaction (`Dialect.readTransaction`), on
 * SQLite and on PostgreSQL alike.
 *
 * @since 1.0.0
 */
import { Flow } from "@smthrs/flow";
import { RunStore } from "@smthrs/run-store";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * The most bytes of UTF-8 one released value holds: 16 KiB.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const valueLimitBytes: number;
/**
 * The most journal events one {@link Service.inspect} returns.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumJournalPage = 500;
/**
 * The most runs one {@link Service.list} returns.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumListPage = 200;
/**
 * The most flow tags one {@link Service.list} filters by.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumListFlows = 64;
/**
 * The most child runs one {@link Service.inspect} returns, oldest first.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const maximumChildren = 200;
/**
 * One value as it is released: redacted JSON text, cut to
 * {@link valueLimitBytes}. `bytes` is the size of the whole redacted text, and
 * `clipped` says the cut happened, so `text` is then a prefix that no longer
 * parses.
 *
 * @category models
 * @since 1.0.0
 */
export interface Value {
    readonly text: string;
    readonly bytes: number;
    readonly clipped: boolean;
}
/**
 * A run's durable wait: its structured kind, the engine's reason and when it
 * wakes. The token that resolves it is never released.
 *
 * @category models
 * @since 1.0.0
 */
export interface Waiting {
    readonly kind: "timer" | "signal" | "approval" | "quota" | "human" | "other";
    readonly reason: string;
    readonly wakeAtMs: number | null;
}
/**
 * One run's lifecycle. `parentRunId` is the effective parent: `parent_run_id`,
 * else the earliest spawn edge. `lastSeq` is the run's latest journal
 * sequence, `-1` with none: an act on the run carries it, so a reader can tell
 * whether the run moved since it looked.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunSummary {
    readonly runId: string;
    readonly flowName: string;
    readonly status: RunStore.RunStatus;
    readonly createdAtMs: number;
    readonly startedAtMs: number | null;
    readonly finishedAtMs: number | null;
    readonly parentRunId: string | null;
    readonly cancelRequestedAtMs: number | null;
    readonly waiting: Waiting | null;
    readonly lastSeq: number;
    /**
     * How the run started, as its caller said when the engine admitted it
     * (`@smthrs/flow` `RunMetrics.CurrentOrigin`): the door and the actor kind,
     * never who. `null` for a run admitted before the engine kept it.
     */
    readonly origin: Origin | null;
}
/**
 * How a run started: the door it came through (such as `button`, `agent` or
 * `flow` for a run another run started) and the kind of actor behind it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Origin {
    readonly door: string;
    readonly actor: string;
}
/**
 * One attempt of a step. `error` is a closed code, the failure's tag, or
 * `defect`, `interrupted` or `failed`; never a message.
 *
 * @category models
 * @since 1.0.0
 */
export interface Attempt {
    readonly attempt: number;
    readonly state: string;
    readonly startedAtMs: number;
    readonly finishedAtMs: number | null;
    readonly outcome: Value | null;
    readonly error: string | null;
}
/**
 * One plan node, folded from its `flows.engine.node-scheduled` and
 * `flows.engine.node-settled` events. A node's attempts are the
 * `flows_attempts` rows whose step key digest its settlement names, so a node
 * still running lists none yet. `output` is its last attempt's outcome, else
 * the result preview its settlement recorded.
 *
 * @category models
 * @since 1.0.0
 */
export interface Step {
    readonly nodeId: string;
    readonly action: string | null;
    readonly kind: string;
    readonly status: "running" | "completed" | "failed" | "waiting" | "skipped";
    readonly scheduledAtMs: number;
    readonly settledAtMs: number | null;
    readonly seq: number;
    readonly output: Value | null;
    readonly attempts: ReadonlyArray<Attempt>;
}
/**
 * A run this run started: an explicit child boundary, or an agent's cell call,
 * whose input and result are that step's input and output.
 *
 * @category models
 * @since 1.0.0
 */
export interface Child extends RunSummary {
    readonly input: Value;
    readonly result: Value | null;
}
/**
 * One journal event of the run, its payload redacted and cut.
 *
 * @category models
 * @since 1.0.0
 */
export interface Event {
    readonly seq: number;
    readonly eventType: string;
    readonly emittedAtMs: number;
    readonly payload: Value;
}
/**
 * One page of a run's journal: the events after `afterSeq`, ascending.
 * `nextSeq` is the last one returned, or `afterSeq` when none were; pass it
 * as the next page's `afterSeq`. `hasMore` says more events exist now.
 *
 * @category models
 * @since 1.0.0
 */
export interface JournalPage {
    readonly events: ReadonlyArray<Event>;
    readonly afterSeq: number;
    readonly nextSeq: number;
    readonly hasMore: boolean;
}
/**
 * What {@link Service.inspect} reads of one run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Inspection {
    readonly run: RunSummary & {
        readonly input: Value;
        readonly result: Value | null;
    };
    readonly steps: ReadonlyArray<Step>;
    readonly children: ReadonlyArray<Child>;
    readonly journal: JournalPage;
}
/**
 * One page of runs, newest first, and the cursor of the next, `null` at the
 * end.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunList {
    readonly runs: ReadonlyArray<RunSummary>;
    readonly cursor: string | null;
}
declare const RunNotFound_base: Schema.Class<RunNotFound, Schema.TaggedStruct<"@smthrs/engine-store/RunNotFound", {
    readonly runId: Schema.String;
}>, import("effect/Cause").YieldableError>;
/**
 * The engine holds no run with this id.
 *
 * @category errors
 * @since 1.0.0
 */
export declare class RunNotFound extends RunNotFound_base {
}
/**
 * The run reads.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
    /**
     * The run, its steps, its children and the journal page after `afterSeq`
     * (default `-1`), at most `limit` events (default and most
     * {@link maximumJournalPage}).
     */
    readonly inspect: (runId: string, options?: {
        readonly afterSeq?: number;
        readonly limit?: number;
    }) => Effect.Effect<Inspection, RunNotFound | RunStore.RunStoreError>;
    /**
     * Runs newest first, `limit` at a time (default 50, at most
     * {@link maximumListPage}), from `cursor`. `roots`, the default, keeps the
     * runs with no parent. `runIds` keeps only those runs, at most
     * {@link maximumListPage} of them (more fail `invalid_run`); a run the
     * engine doesn't hold is left out, so a caller that knows its runs by
     * another index reads their state in one round trip. `flows` keeps only
     * the runs of those flows, by tag, at most {@link maximumListFlows} of them.
     */
    readonly list: (options?: {
        readonly limit?: number;
        readonly cursor?: string;
        readonly roots?: boolean;
        readonly runIds?: ReadonlyArray<string>;
        readonly flows?: ReadonlyArray<string>;
    }) => Effect.Effect<RunList, RunStore.RunStoreError>;
    /**
     * The run's flow and its payload exactly as the engine stored it: encoded
     * and unredacted. It exists to run the same flow again inside the engine,
     * and must never reach a reader or a wire.
     */
    readonly payload: (runId: string) => Effect.Effect<{
        readonly flowName: string;
        readonly payload: unknown;
    }, RunNotFound | RunStore.RunStoreError>;
}
declare const RunInspection_base: Context.ServiceClass<RunInspection, "@smthrs/engine-store/RunInspection", Service>;
/**
 * The run reads, over the engine's database.
 *
 * @category services
 * @since 1.0.0
 */
export declare class RunInspection extends RunInspection_base {
}
/**
 * Cuts `text` to {@link valueLimitBytes} of UTF-8 at a character boundary.
 *
 * @category values
 * @since 1.0.0
 */
export declare const clip: (text: string) => Value;
/**
 * The closed code of a stored failure: the first tag in it that names a
 * failure, `defect` for a defect, `interrupted` for an interruption, else
 * `failed`. Nothing else of the failure is read.
 *
 * @category values
 * @since 1.0.0
 */
export declare const codeOf: (failure: unknown) => string;
/**
 * A value as it is released: failures reduced to codes, redacted, encoded as
 * JSON and cut.
 *
 * @category values
 * @since 1.0.0
 */
export declare const valueOf: (value: unknown) => Value;
/**
 * What Effect writes for a `Redacted` value when it encodes one for display
 * (its `toJSON`): the reads put it wherever a schema-known value held one.
 *
 * @category values
 * @since 1.0.0
 */
export declare const redactedMarker = "<redacted>";
/**
 * What the reads release in place of a value they cannot show safely: one
 * whose schema is known but no longer decodes it, a cut preview of a schema
 * that holds a `Redacted` value, and the output of a node with no action.
 *
 * @category values
 * @since 1.0.0
 */
export declare const withheldMarker = "<withheld>";
/**
 * Whether `schema` holds a `Schema.Redacted` value anywhere: in a field, an
 * element, a union member, a recursive reference or an encoding step.
 *
 * @category values
 * @since 1.0.0
 */
export declare const holdsRedacted: (schema: Schema.Top) => boolean;
/**
 * What the reads know of the flows whose runs they read. With `flows`, a run's
 * payload, its result and each step's output show through their schemas (the
 * flow's, and each action's read off the flow's plan), so a `Schema.Redacted`
 * value reads as `<redacted>` at any depth and a value its schema no longer
 * decodes as `<withheld>`; without, every value is read as stored and only the
 * redactor's rules stand between it and the reader.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
    readonly flows?: ReadonlyArray<Flow.Any> | undefined;
}
/**
 * Builds the reads over `SqlClient`; the engine's migrations must already be
 * applied.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const make: (options?: Options) => Effect.Effect<Service, never, SqlClient.SqlClient>;
/**
 * Provides the run reads over `SqlClient`.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layer: Layer.Layer<RunInspection, never, SqlClient.SqlClient>;
/**
 * Provides the run reads over `SqlClient`, rendering each run's values through
 * its flow in `flows` (see {@link Options}).
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerWith: (options: Options) => Layer.Layer<RunInspection, never, SqlClient.SqlClient>;
export {};
