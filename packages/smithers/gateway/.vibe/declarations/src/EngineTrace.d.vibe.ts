/**
 * Recorded native evidence, decoded through the contracts that wrote it.
 *
 * @since 1.0.0
 */
import * as EngineEvent from "@smthrs/journal/EngineEvent";
import type { JournalRecord, TraceBuilder } from "./RunTrace.vibe";
/**
 * A render-only view of the same decoded execution facts; never persisted.
 *
 * @category models
 * @since 1.0.0
 */
export interface EngineExecutionEvidence {
    readonly executionId: string;
    readonly generation: number;
    readonly spanId: string;
    readonly parentExecutionId?: string | undefined;
    readonly parentKnown: boolean;
    readonly flowName?: string | undefined;
    readonly input?: unknown | undefined;
    readonly coherent: boolean;
    /** Declared nodes, including work not reached at this journal cursor. */
    readonly graph?: EngineEvent.NodeGraph | undefined;
    readonly status: string;
    /** Recorded clock and deferred registrations and their explicit settlements. */
    readonly waits: ReadonlyArray<{
        readonly id: string;
        readonly kind: "sleep" | "signal";
        readonly since: number;
        readonly settledAt?: number;
    }>;
    readonly result?: {
        readonly value: unknown;
        readonly sequence: number;
    } | undefined;
    /** Original classified failure bytes, never parsed from rendered detail. */
    readonly failure?: {
        readonly kind: "cause" | "error" | "defect" | "interrupted" | "encoding";
        readonly value: unknown;
        readonly sequence: number;
    } | undefined;
}
/**
 * Observation completion is separate from the control run's terminal verdict.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const engineProjectionPending: (records?: ReadonlyArray<JournalRecord>) => boolean;
/**
 * Folds native executions and attempts into trace spans with recorded ancestry.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const engineTraceFromJournal: (records: ReadonlyArray<JournalRecord>) => Array<TraceBuilder>;
/**
 * Product claims use these typed facts, never text rendered into trace details.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const engineExecutionEvidence: (records: ReadonlyArray<JournalRecord>) => ReadonlyArray<EngineExecutionEvidence>;
/**
 * Same recorded native ancestry and historical cursor for every product result projection.
 *
 * @category utilities
 * @since 1.0.0
 */
export declare const engineRunEvidence: (records: ReadonlyArray<JournalRecord>, rootId: string, cursorSeq?: number) => {
    executions: EngineExecutionEvidence[];
    completed: EngineExecutionEvidence[];
    belongs: (execution: EngineExecutionEvidence, ownerId?: string) => boolean;
};
