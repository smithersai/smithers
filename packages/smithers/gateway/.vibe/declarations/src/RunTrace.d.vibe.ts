/**
 * The run trace model (factory spec 06, "the run trace": one card shows every
 * run).
 *
 * A run is a recursive program: the agent writes REPL cells in a code
 * container, every `ctx.call` is a durable span, and each turn is a frame. The
 * control journal already records exactly that (`@smthrs/agent` AgentSession
 * journals turn-opened, model-settled, cell-produced, cell-call-started,
 * cell-call-settled, cell-printed, cell-settled, resolved), and the gateway
 * serves it as the `run-events` projection the run card already reads. This
 * module folds those records into a span tree, run → frame → cell → call, and
 * the geometry of one bar per span on a shared time axis. No second data
 * source: what the journal does not carry (realm variables, child runs' own
 * frames) the model does not invent.
 *
 * Pure: the card renders the model, the tests read it from a fixture.
 * @since 1.0.0
 */
import { CallPresentation, type FlowDescriptor } from "@smthrs/registry/Descriptor";
export { inspectLabel } from "../../../src/internal/inspectLabels.ts";
/** One control journal record, as the run card stores it (the run-events projection's row shape).
 *
 * @category models
 * @since 1.0.0
 */
export interface JournalRecord {
    readonly runId?: string | undefined;
    readonly sequence?: number | undefined;
    readonly kind?: string | undefined;
    readonly occurredAt?: number | undefined;
    readonly payload?: unknown | undefined;
}
/**
 * What kind of node a span is in the tree. `fork` is the row 0 of a forked run
 * (spec 06 §1); no journal record folds into it yet, so no fold produces one.
 *
 * @category models
 * @since 1.0.0
 */
export type SpanKind = "run" | "frame" | "model" | "cell" | "call" | "approval" | "resolved" | "event" | "fork" | "execution" | "attempt";
/** What the journal said about the span; the run root wears the run's own status word.
 *
 * @category models
 * @since 1.0.0
 */
export type SpanStatus = "running" | "completed" | "failed" | "waiting" | "approved" | "denied" | string;
/** The facts the details pane shows for one span: only what its journal records carry.
 *
 * @category models
 * @since 1.0.0
 */
export interface SpanDetail {
    /** The journal sequence that opened the span. */
    readonly sequence?: number | undefined;
    /** The journal kind that opened the span. */
    readonly event?: string | undefined;
    readonly seat?: string | undefined;
    /** A cell's source text. */
    readonly source?: string | undefined;
    /** What a cell printed for the next model turn. */
    readonly printed?: string | undefined;
    /**
     * A call's flow name exactly as journaled. The span's `label` is its
     * display form; read call semantics from this field, never from the label.
     *
     * @since 1.0.0
     */
    readonly flowName?: string | undefined;
    /** A call's input, as journaled. */
    readonly input?: unknown | undefined;
    /** A call's settled value, a model's text, or a resolved text. */
    readonly output?: string | undefined;
    /** A detached child's recorded execution id; only the agent/spawn result establishes this edge. */
    readonly childRunId?: string | undefined;
    /** A failure's message. */
    readonly message?: string | undefined;
    readonly usage?: {
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
    } | undefined;
    /** Every other payload field the opening record carried, as the journal bound it. */
    readonly fields?: Readonly<Record<string, unknown>> | undefined;
}
/**
 * One nested execution span with its original journal evidence.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceSpan {
    readonly id: string;
    readonly kind: SpanKind;
    readonly label: string;
    readonly status: SpanStatus;
    readonly startedAt: number;
    /** Absent while the span is open. */
    readonly endedAt?: number | undefined;
    readonly depth: number;
    readonly children: ReadonlyArray<TraceSpan>;
    readonly detail: SpanDetail;
}
/** The run the trace belongs to, as the run card knows it.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceRun {
    readonly runId: string;
    readonly flowId: string;
    /** The run card's phase word (running, completed, failed, cancelled, waiting-approval, ...). */
    readonly status: string;
    readonly kind?: string | undefined;
}
/**
 * The recorded start and end of a trace in milliseconds.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceExtent {
    readonly start: number;
    readonly end: number;
}
/**
 * What a frame was doing, derived from what it did — never declared.
 *
 * `unrecorded` is the honest reading of a frame whose journal carries nothing
 * this fold can name: every other word here is a claim about the frame's work,
 * and a claim needs a record behind it.
 *
 * @category models
 * @since 1.0.0
 */
export type PhaseId = "researching" | "implementing" | "testing" | "stuck" | "blocked" | "unrecorded";
/** One contiguous run of frames in one phase.
 *
 * @category models
 * @since 1.0.0
 */
export interface PhaseBand {
    readonly phase: PhaseId;
    readonly startedAt: number;
    readonly endedAt: number;
    /** Span ids of the frames in this band, in order. */
    readonly frames: ReadonlyArray<string>;
    /** Journal sequence to scrub to when this band is clicked. */
    readonly seq: number;
}
/** A moment a person would scrub to.
 *
 * @category models
 * @since 1.0.0
 */
export interface Milestone {
    readonly seq: number;
    readonly at: number;
    readonly label: string;
    /** `muted` is a person's stop: neither a success nor a failure. */
    readonly tone: "warn" | "bad" | "good" | "brand" | "muted";
    /**
     * The frame this moment was recorded under, carried through the scoped
     * merge. Two steps run at once in one journal, so the frame a milestone
     * belongs to is the one its OWN step had open, never whichever frame opened
     * last.
     */
    readonly spanId: string;
}
/**
 * The frame one journal record was recorded under.
 *
 * The strip scrubs to sequences no milestone names, so the ownership rule has
 * to hold for every record, not only for the ones that mint a pin.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceOwner {
    readonly seq: number;
    readonly spanId: string;
}
/** What one frame did, in plain English, derived from its calls.
 *
 * @category models
 * @since 1.0.0
 */
export interface FrameLine {
    readonly spanId: string;
    /** Frame ordinal as shown to a person, 1-based. */
    readonly frame: number;
    readonly verb: string;
    /** Empty when the call's input named nothing this fold reads as a subject; the card then prints the verb alone. */
    readonly subject: string;
    readonly result: string;
    readonly failed: boolean;
    readonly wrote: boolean;
    /** Frame ordinal this repeats, set ONLY inside a stall streak. */
    readonly repeatOf?: number | undefined;
}
/** A discipline event, rendered where it happened.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceNote {
    readonly seq: number;
    /** Span id of the frame it attaches under. */
    readonly spanId: string;
    readonly tone: "warn" | "bad" | "good";
    readonly title: string;
    readonly body: string;
    /** Quoted evidence lines, already clipped. */
    readonly evidence?: ReadonlyArray<string> | undefined;
}
/** Extra options the fold takes; every field optional, absent = today's behaviour.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceOptions {
    /** Plan targets are coverage requirements, never evidence that a call ran tests. */
    readonly checkTargets?: ReadonlyArray<string> | undefined;
}
/**
 * The shared projection rendered by app and terminal monitors.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceModel {
    /** Source records for status and check receipts, including their settlement sequences. */
    readonly journal: ReadonlyArray<JournalRecord>;
    readonly root: TraceSpan;
    /** Every span in tree order, with its depth: the tree's rows and the waterfall's rows. */
    readonly rows: ReadonlyArray<TraceSpan>;
    readonly extent: TraceExtent;
    readonly counts: {
        readonly spans: number;
        readonly running: number;
        readonly failed: number;
    };
    /** The run's frames merged into what they were doing; empty when the journal opened no frame. */
    readonly bands: ReadonlyArray<PhaseBand>;
    /** The moments a person scrubs to, in journal order; empty when the journal recorded none. */
    readonly milestones: ReadonlyArray<Milestone>;
    /** One line per frame that called something; a frame that called nothing has none. */
    readonly lines: ReadonlyArray<FrameLine>;
    /** The discipline records that carry fields, attached where they happened. */
    readonly notes: ReadonlyArray<TraceNote>;
    /** Every recorded sequence with the frame it was recorded under, in journal order. */
    readonly owners: ReadonlyArray<TraceOwner>;
}
/** Mutable draft shared by the control and native journal folds; never persisted.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceBuilder {
    readonly id: string;
    readonly kind: SpanKind;
    label: string;
    status: SpanStatus;
    startedAt: number;
    endedAt?: number | undefined;
    readonly children: Array<TraceBuilder>;
    detail: SpanDetail;
}
/**
 * What a recorded call means: what it did, and how it reads.
 *
 * The rows, the phase bands and the run header all read a call through this
 * one answer, so they cannot tell three different stories about one record.
 *
 * @category models
 * @since 1.0.0
 */
export type CallMetadata = Pick<FlowDescriptor, "activity" | "presentation">;
/**
 * What one recorded call was about, in the shape its declaration chose.
 *
 * Exported because the run header names the same subject as the row beneath
 * it: two readings of one input is two answers to one question.
 *
 * @param input the call input, as journaled
 * @param format the declared subject field, when the declaration named one
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const callSubject: (input: unknown, format?: CallPresentation["subject"]) => string;
/**
 * The one reading of a recorded call's semantics, shared by the rows, the
 * phase bands and the run header.
 *
 * Precedence, and why: the record's own `descriptor` wins, because it is what
 * the declaration said when the call was made, and only a record that carries
 * none falls back to {@link LEGACY_PRESENTATION}, which is a guess about the
 * flows that were journaled before a declaration could say anything. A flow the
 * table does not know stays unknown, and unknown is said as unknown.
 *
 * `bash` is the one activity read off the call rather than the declaration.
 * `@smthrs/std` declares none for it on purpose — the same flow runs a test
 * suite, a type check and `cat` — so a recognised runner in the recorded
 * command is the only thing that names the activity, and an explicit
 * declaration still outranks it.
 *
 * @param flowName the flow the record names
 * @param payload the `cell-call-started` payload, as journaled
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const callSemantics: (flowName: string, payload: Record<string, unknown>) => CallMetadata;
/**
 * A run's trace fold, advanced one record at a time.
 *
 * {@link traceFromJournal} is {@link traceFold} over the whole journal and then
 * {@link traceFoldModel}; a live reader keeps the fold and hands it each new
 * record with {@link traceFoldStep}, so a record costs its own work rather than
 * a refold of the journal before it. The fold is mutable: stepping it consumes
 * the value it was, and a reader that needs an older trace takes a model first.
 *
 * @category models
 * @since 1.0.0
 */
export interface TraceFold {
    readonly run: Omit<TraceRun, "status">;
    /** Every record stepped, in sequence order: the model's `journal`. */
    readonly journal: ReadonlyArray<JournalRecord>;
}
/**
 * Folds `records` into a fold that later records can be stepped onto.
 *
 * @param run the run the journal belongs to
 * @param records its journal so far, in any order
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const traceFold: (run: Omit<TraceRun, "status">, records?: ReadonlyArray<JournalRecord>) => TraceFold;
/**
 * Folds one more record onto `fold`, which it returns.
 *
 * A record in sequence order costs its own work. One that arrives before a
 * sequence already stepped, or a native fact that supersedes telemetry the
 * fold already placed, refolds the journal, because the batch rules move an
 * earlier record for both.
 *
 * @param fold the fold; consumed
 * @param record the next journal record
 *
 * @category combinators
 * @since 1.0.0
 */
export declare const traceFoldStep: (fold: TraceFold, record: JournalRecord) => TraceFold;
/**
 * Brings `fold` up to `records`, stepping only what it has not read.
 *
 * `records` extends the array the fold last read when every earlier element is
 * the same object; anything else, or a different run, starts a new fold. The
 * comparison is against the records the fold consumed, not the caller's array,
 * so growing or rewriting that same array in place is seen. A reader that
 * re-renders one growing journal therefore pays per new record.
 *
 * @param fold the fold the reader holds, if any; consumed
 * @param run the run the journal belongs to
 * @param records the whole journal as the reader now holds it
 *
 * @category combinators
 * @since 1.0.0
 */
export declare const traceFoldSync: (fold: TraceFold | undefined, run: Omit<TraceRun, "status">, records: ReadonlyArray<JournalRecord>) => TraceFold;
/**
 * The trace a fold has read, as the run with `status` shows it.
 *
 * Taken again without a step between, it is the same object.
 *
 * @param fold the fold
 * @param status the run card's phase word
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const traceFoldModel: (fold: TraceFold, status: string) => TraceModel;
/**
 * Fold each recorded dispatch independently, keeping prompt-run addresses unchanged.
 *
 * The same fold a live reader advances with {@link traceFoldStep}, taken over
 * the whole journal at once.
 *
 * The options the card carries are accepted and read by nothing: a plan's
 * check targets are a coverage requirement, and a requirement is not evidence
 * that any call ran it. Every word this fold says is read off a record.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const traceFromJournal: (run: TraceRun, records: ReadonlyArray<JournalRecord>, _options?: TraceOptions) => TraceModel;
/**
 * One span's bar on the shared axis, as percentages. An open span runs to the
 * axis end; an instant span is zero width and renders as a marker.
 *
 * @param span the span
 * @param extent the axis
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const waterfallGeometry: (span: TraceSpan, extent: TraceExtent) => {
    readonly left: number;
    readonly width: number;
};
/**
 * The axis the phase strip measures on: the bands' own span when the journal
 * opened frames, the run's whole extent when it opened none.
 *
 * A milestone is a journal record, and the records that write one do not need a
 * frame: a journal of `read-only-demanded` and `sufficiency-observed` with no
 * `turn-opened` carries two moments and opens no band. Milestones therefore
 * survive without bands, and the axis that places them cannot be read off the
 * bands alone. The other choice — dropping a moment because no band was drawn
 * beside it — would be this fold deciding a record the journal made did not
 * happen, which is the one thing it may never do.
 *
 * @param model the trace
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const phaseExtent: (model: TraceModel) => TraceExtent;
/**
 * One band's share of that axis, as percentages, the way the waterfall measures
 * a span.
 *
 * A run whose frames all land in one millisecond recorded no elapsed time. Read
 * against a floored axis every such band is zero wide at left 0, so the whole
 * strip collapses onto the left edge and says nothing at all. The bands' ORDER
 * is a journal fact even where their durations are not, so with no duration to
 * measure the ordinal IS the axis: equal slices, left to right.
 *
 * @param band the band
 * @param extent the axis, from {@link phaseExtent}
 * @param index the band's place in the strip
 * @param count how many bands the strip holds
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const phaseBandGeometry: (band: PhaseBand, extent: TraceExtent, index: number, count: number) => {
    readonly left: number;
    readonly width: number;
};
/** Whether a span, or any span under it, passes the filter.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const spanMatches: (span: TraceSpan, filter: TraceFilter) => boolean;
/** The tree's filters, in the slash grammar's words (spec 06 §6: `runs.trace.filter <runId> <filter>`).
 *
 * @category models
 * @since 1.0.0
 */
export type TraceFilter = "all" | "running" | "failed" | "model" | "flow" | "messages";
/**
 * Stable filter identifiers accepted by run trace commands.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const TRACE_FILTER_IDS: ReadonlyArray<TraceFilter>;
/**
 * The filter chips a run of this kind shows (spec 06 §2 and §3): a prototype
 * has `all | messages | failed` and nothing else; every other run has the
 * shared set. `messages` is a prototype's conversation across workers, so it
 * is not offered elsewhere.
 *
 * @param kind the run's kind
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const traceFiltersFor: (kind: string | undefined) => ReadonlyArray<readonly [TraceFilter, string]>;
/** Whether a filter word is one the trace knows.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const isTraceFilter: (value: string) => value is TraceFilter;
/** The two presentations of the same persisted run card.
 *
 * @category models
 * @since 1.0.0
 */
export type TraceView = "turns" | "timeline";
/** A concise projection of one recorded turn, never a generated claim about intent or correctness.
 *
 * @category models
 * @since 1.0.0
 */
export interface TurnNarrative {
    readonly frame: TraceSpan;
    readonly number: number;
    readonly text: string;
    readonly source: "model" | "calls" | "journal";
}
/** One cheap line per turn; falls back to actual call names when the model recorded only code.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const turnNarratives: (model: TraceModel) => ReadonlyArray<TurnNarrative>;
/** The recorded ancestry of a selection, for breadcrumbs and the selected turn's scoped call tree.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const spanPath: (model: TraceModel, id: string) => ReadonlyArray<TraceSpan>;
/** A duration in the trace's units: milliseconds under a second, seconds under a minute, minutes and seconds under an hour, hours and minutes after.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const durationWords: (ms: number) => string;
/** One memory item a run's relevance readings weighed.
 *
 * @category models
 * @since 1.0.0
 */
export interface MemoryItem {
    readonly id: string;
    readonly kind: string;
    /** How likely the item is needed: 1 − Jev's probability that it is not. */
    readonly relevance: number;
}
/** The memory a run was shown and the memory Jev withheld from it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RunMemory {
    readonly kept: ReadonlyArray<MemoryItem>;
    readonly withheld: ReadonlyArray<MemoryItem>;
}
/**
 * What memory a run was brought, from the `control.agent.relevance-settled`
 * rows of its `run-events` projection: ids and probabilities, never text. A
 * reading also weighs flows, skills and instructions; only memory counts here.
 * An item any reading kept is in; one only ever withheld is withheld; both
 * most relevant first. A row whose verdicts were not retained is no reading.
 * Undefined when Jev never read for the run.
 *
 * @category folds
 * @since 1.0.0
 */
export declare const runMemoryOf: (records: ReadonlyArray<JournalRecord>) => RunMemory | undefined;
/** One recorded agent action inside an engine step, as an Inspect cell.
 *
 * @category models
 * @since 1.0.0
 */
export interface TranscriptCell {
    readonly id: string;
    readonly kind: "read" | "edit" | "run" | "think" | "ask";
    label: string;
    code?: string;
    output?: string;
    quote?: string;
    tokens?: number;
    took_s?: number;
    tone?: "ok" | "fail" | "live";
}
/** Adapt the canonical trace to the install monitor. IDs and timestamps come
 * from recorded spans; inspection never evaluates flow bodies or presentations.
 * @since 1.0.0
 * @category constructors
 */
export declare const monitorFromJournal: (run: TraceRun, records: ReadonlyArray<JournalRecord>, at?: number, options?: {
    readonly childBoundaries?: boolean;
}) => {
    presentation: {
        kind: "text";
        text: string;
    };
    id: string;
    flow: string;
    version: string;
    title: string;
    state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
    attempts: {
        n: number;
        run_id: string;
        state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
        steps: {
            key: string;
            id: string;
            k: number;
            label: string;
            state: string;
            started_at: string;
            ended_at?: string;
            took_s?: number;
            input?: {} | null;
            output?: string;
            meter?: readonly string[];
            model_calls?: number;
            tokens?: number;
        }[];
        phases: {
            id: string;
            step: string;
            title: string;
            took_s: number;
            tone: "fail" | "live" | "ok" | "wait";
            cells: (Omit<TranscriptCell, "tone"> & {
                tone?: ReturnType<(value: string) => "live" | "ok" | "fail" | "wait">;
            })[];
        }[];
        graph: {
            id: string;
            label: string;
            state: "current" | "done" | "failed" | "next" | "waiting";
            deps: string[];
        }[];
    }[];
    waits: ({
        id: string;
        kind: "approval";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    } | {
        id: string;
        kind: "signal" | "sleep";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    })[];
    tokens: number;
    time_s: number;
    cost_usd?: number;
    unmetered_tokens?: number;
    engine: {
        label: string;
        detail: string;
    }[];
    journal: {
        seq: number;
        at: string;
        type: string;
        text: string;
    }[];
    replay?: {
        at: number;
        last: number;
    };
} | {
    presentation?: never;
    id: string;
    flow: string;
    version: string;
    title: string;
    state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
    attempts: {
        n: number;
        run_id: string;
        state: "done" | "failed" | "held" | "interrupted" | "running" | "waiting";
        steps: {
            key: string;
            id: string;
            k: number;
            label: string;
            state: string;
            started_at: string;
            ended_at?: string;
            took_s?: number;
            input?: {} | null;
            output?: string;
            meter?: readonly string[];
            model_calls?: number;
            tokens?: number;
        }[];
        phases: {
            id: string;
            step: string;
            title: string;
            took_s: number;
            tone: "fail" | "live" | "ok" | "wait";
            cells: (Omit<TranscriptCell, "tone"> & {
                tone?: ReturnType<(value: string) => "live" | "ok" | "fail" | "wait">;
            })[];
        }[];
        graph: {
            id: string;
            label: string;
            state: "current" | "done" | "failed" | "next" | "waiting";
            deps: string[];
        }[];
    }[];
    waits: ({
        id: string;
        kind: "approval";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    } | {
        id: string;
        kind: "signal" | "sleep";
        label: string;
        since: string;
        settled?: {
            by: {
                kind: "system";
                color_index: 7;
            };
            at: string;
        };
    })[];
    tokens: number;
    time_s: number;
    cost_usd?: number;
    unmetered_tokens?: number;
    engine: {
        label: string;
        detail: string;
    }[];
    journal: {
        seq: number;
        at: string;
        type: string;
        text: string;
    }[];
    replay?: {
        at: number;
        last: number;
    };
};
