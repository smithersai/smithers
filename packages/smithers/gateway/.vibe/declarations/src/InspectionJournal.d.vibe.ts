/** Adapt a redacted engine inspection page to the canonical run trace fold.
 * No engine state is inferred from the present-day inspection's step rows.
 * @since 1.0.0
 */
import { type JournalRecord, type TraceRun } from "./RunTrace.vibe";
/** A redacted event released by RunInspection.
 * @since 1.0.0
 * @category models
 */
export interface InspectionEvent {
    readonly seq: number;
    readonly eventType: string;
    readonly emittedAtMs: number;
    readonly payload: {
        readonly text: string;
        readonly bytes: number;
        readonly clipped: boolean;
    };
}
/** Clipped or invalid evidence is never parsed into invented graph state.
 * @since 1.0.0
 * @category projections
 */
export declare const inspectionJournal: (runId: string, events: ReadonlyArray<InspectionEvent>) => ReadonlyArray<JournalRecord>;
/** The same monitor model used by CLI/TUI, from RunInspection's public events.
 * @since 1.0.0
 * @category projections
 */
export declare const monitorFromInspection: (run: TraceRun, events: ReadonlyArray<InspectionEvent>, at?: number) => {
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
            cells: (Omit<import("./RunTrace.vibe").TranscriptCell, "tone"> & {
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
            cells: (Omit<import("./RunTrace.vibe").TranscriptCell, "tone"> & {
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
/** Merge existing run journals into a deterministic presentation cursor. Native
 * envelope sequences remain intact; only the read-only row cursor is ordinal.
 * @since 1.0.0
 * @category projections
 */
export declare const inspectionForest: (pages: ReadonlyArray<{
    readonly runId: string;
    readonly events: ReadonlyArray<InspectionEvent>;
}>) => {
    records: {
        runId?: string | undefined;
        kind?: string | undefined;
        occurredAt?: number | undefined;
        payload?: unknown | undefined;
        sequence: number | undefined;
    }[];
    events: {
        eventType: string;
        emittedAtMs: number;
        payload: {
            readonly text: string;
            readonly bytes: number;
            readonly clipped: boolean;
        };
        runId: string;
        nativeSeq: number;
        seq: number;
    }[];
};
