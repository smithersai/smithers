import * as _smithers_db_adapter from '@smithers/db/adapter';
import { SmithersDb as SmithersDb$6 } from '@smithers/db/adapter';
import { SmithersEvent } from '@smithers/observability/SmithersEvent';
import { Metric } from 'effect';
import * as effect_MetricState from 'effect/MetricState';
import * as effect_MetricKeyType from 'effect/MetricKeyType';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';

type RewindAuditResult$4 = "success" | "failed" | "partial" | "in_progress";

type RewindLockHandle$2 = {
    runId: string;
    release: () => boolean;
};

type JumpStepName$1 = "snapshot-pre-jump" | "pause-event-loop" | "revert-sandboxes" | "truncate-frames" | "truncate-attempts" | "truncate-outputs" | "invalidate-diffs" | "rebuild-reconciler" | "resume-event-loop";

type JumpToFrameInput$2 = {
    adapter: SmithersDb$6;
    runId: unknown;
    frameNo: unknown;
    confirm?: unknown;
    caller?: string;
    pauseRunLoop?: () => Promise<void> | void;
    resumeRunLoop?: () => Promise<void> | void;
    captureReconcilerState?: () => Promise<unknown> | unknown;
    restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
    rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
    emitEvent?: (event: SmithersEvent) => Promise<void> | void;
    getCurrentPointerImpl?: (cwd?: string) => Promise<string | null>;
    revertToPointerImpl?: (pointer: string, cwd?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    nowMs?: () => number;
    rateLimit?: {
        maxPerWindow?: number;
        windowMs?: number;
    };
    hooks?: {
        beforeStep?: (step: JumpStepName$1) => Promise<void> | void;
        afterStep?: (step: JumpStepName$1) => Promise<void> | void;
    };
    onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
};

type JumpResult$2 = {
    ok: true;
    newFrameNo: number;
    revertedSandboxes: number;
    deletedFrames: number;
    deletedAttempts: number;
    invalidatedDiffs: number;
    durationMs: number;
};

type VcsTag$1 = {
    runId: string;
    frameNo: number;
    vcsType: string;
    vcsPointer: string;
    vcsRoot: string | null;
    jjOperationId: string | null;
    createdAtMs: number;
};

/**
 * Branch metadata.
 */
type BranchInfo$2 = {
    runId: string;
    parentRunId: string;
    parentFrameNo: number;
    branchLabel: string | null;
    forkDescription: string | null;
    createdAtMs: number;
};

/**
 * Timeline entry for a single frame in a run.
 */
type TimelineFrame$1 = {
    frameNo: number;
    createdAtMs: number;
    contentHash: string;
    forkPoints: BranchInfo$2[];
};

/**
 * Timeline for a single run.
 */
type RunTimeline$1 = {
    runId: string;
    frames: TimelineFrame$1[];
    branch: BranchInfo$2 | null;
};

/**
 * Recursive timeline tree including forks.
 */
type TimelineTree$3 = {
    timeline: RunTimeline$1;
    children: TimelineTree$3[];
};

type NodeSnapshot$1 = {
    nodeId: string;
    iteration: number;
    state: string;
    lastAttempt: number | null;
    outputTable: string;
    label: string | null;
};

type NodeChange$1 = {
    nodeId: string;
    from: NodeSnapshot$1;
    to: NodeSnapshot$1;
};

type OutputChange$1 = {
    key: string;
    from: unknown;
    to: unknown;
};

type RalphSnapshot$1 = {
    ralphId: string;
    iteration: number;
    done: boolean;
};

type RalphChange$1 = {
    ralphId: string;
    from: RalphSnapshot$1;
    to: RalphSnapshot$1;
};

/**
 * Structured diff between two snapshots.
 */
type SnapshotDiff$1 = {
    nodesAdded: string[];
    nodesRemoved: string[];
    nodesChanged: NodeChange$1[];
    outputsAdded: string[];
    outputsRemoved: string[];
    outputsChanged: OutputChange$1[];
    ralphChanged: RalphChange$1[];
    inputChanged: boolean;
    vcsPointerChanged: boolean;
};

type SnapshotData$1 = {
    nodes: Array<{
        nodeId: string;
        iteration: number;
        state: string;
        lastAttempt: number | null;
        outputTable: string;
        label: string | null;
    }>;
    outputs: Record<string, unknown>;
    ralph: Array<{
        ralphId: string;
        iteration: number;
        done: boolean;
    }>;
    input: Record<string, unknown>;
    vcsPointer?: string | null;
    workflowHash?: string | null;
};

/**
 * Serialized snapshot of workflow state at a specific frame.
 */
type Snapshot$3 = {
    runId: string;
    frameNo: number;
    nodesJson: string;
    outputsJson: string;
    ralphJson: string;
    inputJson: string;
    vcsPointer: string | null;
    workflowHash: string | null;
    contentHash: string;
    createdAtMs: number;
};

type ReplayResult$1 = {
    runId: string;
    branch: BranchInfo$2;
    snapshot: Snapshot$3;
    vcsRestored: boolean;
    vcsPointer: string | null;
    vcsError?: string;
};

/**
 * Parameters for replaying from a checkpoint.
 */
type ReplayParams$1 = {
    parentRunId: string;
    frameNo: number;
    inputOverrides?: Record<string, unknown>;
    resetNodes?: string[];
    branchLabel?: string;
    restoreVcs?: boolean;
    cwd?: string;
};

/**
 * Parsed snapshot data for diffing and display.
 */
type ParsedSnapshot$2 = {
    runId: string;
    frameNo: number;
    nodes: Record<string, NodeSnapshot$1>;
    outputs: Record<string, unknown>;
    ralph: Record<string, RalphSnapshot$1>;
    input: Record<string, unknown>;
    vcsPointer: string | null;
    workflowHash: string | null;
    contentHash: string;
    createdAtMs: number;
};

/**
 * Parameters for forking a run.
 */
type ForkParams$1 = {
    parentRunId: string;
    frameNo: number;
    inputOverrides?: Record<string, unknown>;
    resetNodes?: string[];
    branchLabel?: string;
    forkDescription?: string;
};

/**
 * @param {Parameters<typeof replayFromCheckpointEffect>} ...args
 */
declare function replayFromCheckpoint(...args: any[]): Promise<{
    runId: string;
    branch: BranchInfo$2;
    snapshot: Snapshot$3;
    vcsRestored: boolean;
    vcsPointer: string | null;
    vcsError: string | undefined;
}>;

declare const snapshotsCaptured: Metric.Metric.Counter<number>;

declare const runForksCreated: Metric.Metric.Counter<number>;

declare const replaysStarted: Metric.Metric.Counter<number>;

declare const snapshotDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

/** @typedef {import("../ParsedSnapshot.ts").ParsedSnapshot} ParsedSnapshot */
/** @typedef {import("./Snapshot.ts").Snapshot} Snapshot */
/**
 * @param {Snapshot} snapshot
 * @returns {ParsedSnapshot}
 */
declare function parseSnapshot(snapshot: Snapshot$2): ParsedSnapshot$1;
type ParsedSnapshot$1 = ParsedSnapshot$2;
type Snapshot$2 = Snapshot$3;

/**
 * @param {Parameters<typeof captureSnapshotEffect>} ...args
 */
declare function captureSnapshot(...args: any[]): Promise<Snapshot$3>;
/**
 * @param {Parameters<typeof loadSnapshotEffect>} ...args
 */
declare function loadSnapshot(...args: any[]): Promise<Snapshot$3 | undefined>;
/**
 * @param {Parameters<typeof loadLatestSnapshotEffect>} ...args
 */
declare function loadLatestSnapshot(...args: any[]): Promise<Snapshot$3 | undefined>;
/**
 * @param {Parameters<typeof listSnapshotsEffect>} ...args
 */
declare function listSnapshots(...args: any[]): Promise<Pick<Snapshot$3, "runId" | "frameNo" | "vcsPointer" | "contentHash" | "createdAtMs">[]>;

/**
 * Compute a structured diff between two parsed snapshots.
 */
declare function diffSnapshots(a: any, b: any): {
    nodesAdded: string[];
    nodesRemoved: string[];
    nodesChanged: {
        nodeId: string;
        from: any;
        to: any;
    }[];
    outputsAdded: string[];
    outputsRemoved: string[];
    outputsChanged: {
        key: string;
        from: any;
        to: any;
    }[];
    ralphChanged: {
        ralphId: string;
        from: any;
        to: any;
    }[];
    inputChanged: boolean;
    vcsPointerChanged: boolean;
};
/**
 * Convenience: diff two raw Snapshot rows.
 */
declare function diffRawSnapshots(a: any, b: any): {
    nodesAdded: string[];
    nodesRemoved: string[];
    nodesChanged: {
        nodeId: string;
        from: any;
        to: any;
    }[];
    outputsAdded: string[];
    outputsRemoved: string[];
    outputsChanged: {
        key: string;
        from: any;
        to: any;
    }[];
    ralphChanged: {
        ralphId: string;
        from: any;
        to: any;
    }[];
    inputChanged: boolean;
    vcsPointerChanged: boolean;
};
/**
 * Colorized terminal output for a snapshot diff.
 */
declare function formatDiffForTui(diff: any): string;
/**
 * Structured JSON output for a snapshot diff.
 */
declare function formatDiffAsJson(diff: any): any;

/**
 * @param {Parameters<typeof forkRunEffect>} ...args
 */
declare function forkRun(...args: any[]): Promise<{
    runId: string;
    branch: BranchInfo;
    snapshot: Snapshot;
}>;
/**
 * @param {Parameters<typeof listBranchesEffect>} ...args
 */
declare function listBranches(...args: any[]): Promise<BranchInfo$2[]>;
/**
 * @param {Parameters<typeof getBranchInfoEffect>} ...args
 */
declare function getBranchInfo(...args: any[]): Promise<BranchInfo$2 | undefined>;

/**
 * @param {Parameters<typeof tagSnapshotVcsEffect>} ...args
 */
declare function tagSnapshotVcs(...args: any[]): Promise<VcsTag$1 | null>;
/**
 * @param {Parameters<typeof loadVcsTagEffect>} ...args
 */
declare function loadVcsTag(...args: any[]): Promise<VcsTag$1 | undefined>;
/**
 * @param {Parameters<typeof resolveWorkflowAtRevisionEffect>} ...args
 */
declare function resolveWorkflowAtRevision(...args: any[]): Promise<{
    workspacePath: string;
    vcsPointer: string;
} | null>;
/**
 * @param {Parameters<typeof rerunAtRevisionEffect>} ...args
 */
declare function rerunAtRevision(...args: any[]): Promise<{
    restored: boolean;
    vcsPointer: string | null;
    error?: string;
}>;

/** @typedef {import("../TimelineTree.ts").TimelineTree} TimelineTree */
/**
 * @param {TimelineTree} tree
 * @returns {string}
 */
declare function formatTimelineForTui(tree: TimelineTree$2, indent?: number): string;
type TimelineTree$2 = TimelineTree$3;

/** @typedef {import("../TimelineTree.ts").TimelineTree} TimelineTree */
/**
 * @param {TimelineTree} tree
 * @returns {object}
 */
declare function formatTimelineAsJson(tree: TimelineTree$1): object;
type TimelineTree$1 = TimelineTree$3;

/**
 * @param {Parameters<typeof buildTimelineEffect>} ...args
 */
declare function buildTimeline(...args: any[]): Promise<RunTimeline$1>;
/**
 * @param {Parameters<typeof buildTimelineTreeEffect>} ...args
 */
declare function buildTimelineTree(...args: any[]): Promise<TimelineTree$3>;

/**
 * Full state snapshot captured at each frame commit.
 * PK: (run_id, frame_no)
 */
declare const smithersSnapshots: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_snapshots";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        frameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "frame_no";
            tableName: "_smithers_snapshots";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        nodesJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "nodes_json";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        outputsJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "outputs_json";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        ralphJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "ralph_json";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        inputJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "input_json";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsPointer: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_pointer";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        workflowHash: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "workflow_hash";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        contentHash: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "content_hash";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_snapshots";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
/**
 * Parent-child fork relationships between runs.
 * PK: run_id (the child run)
 */
declare const smithersBranches: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_branches";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_branches";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        parentRunId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "parent_run_id";
            tableName: "_smithers_branches";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        parentFrameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "parent_frame_no";
            tableName: "_smithers_branches";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        branchLabel: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "branch_label";
            tableName: "_smithers_branches";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        forkDescription: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "fork_description";
            tableName: "_smithers_branches";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_branches";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
/**
 * VCS revision metadata per snapshot.
 * PK: (run_id, frame_no)
 */
declare const smithersVcsTags: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_vcs_tags";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        frameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "frame_no";
            tableName: "_smithers_vcs_tags";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        vcsType: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_type";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsPointer: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_pointer";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsRoot: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_root";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        jjOperationId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "jj_operation_id";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_vcs_tags";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;

declare class JumpToFrameError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {{ hint?: string; details?: Record<string, unknown> }} [options]
     */
    constructor(code: string, message: string, options?: {
        hint?: string;
        details?: Record<string, unknown>;
    });
    /** @type {string} */
    code: string;
    /** @type {string | undefined} */
    hint: string | undefined;
    /** @type {Record<string, unknown> | undefined} */
    details: Record<string, unknown> | undefined;
}

/**
 * Validate a jump run id argument.
 *
 * @param {unknown} runId
 * @returns {string}
 */
declare function validateJumpRunId(runId: unknown): string;

/**
 * Validate a jump frame number argument.
 *
 * @param {unknown} frameNo
 * @returns {number}
 */
declare function validateJumpFrameNo(frameNo: unknown): number;

/**
 * Rewind a run to a previous frame and make it resumable from that point.
 *
 * @param {JumpToFrameInput} input
 * @returns {Promise<JumpResult>}
 */
declare function jumpToFrame(input: JumpToFrameInput$1): Promise<JumpResult$1>;
type JumpResult$1 = JumpResult$2;
type JumpToFrameInput$1 = JumpToFrameInput$2;

/** @typedef {import("./RewindLockHandle.ts").RewindLockHandle} RewindLockHandle */
/**
 * Acquire a single-flight lock for one run.
 * Returns null when another rewind for this run is already in progress.
 *
 * @param {string} runId
 * @returns {RewindLockHandle | null}
 */
declare function acquireRewindLock(runId: string): RewindLockHandle$1 | null;
type RewindLockHandle$1 = RewindLockHandle$2;

/**
 * Check whether a run currently holds a rewind lock.
 *
 * @param {string} runId
 * @returns {boolean}
 */
declare function hasRewindLock(runId: string): boolean;

/**
 * Reset lock state for tests.
 */
declare function resetRewindLocksForTests(): void;

declare const REWIND_RATE_LIMIT_MAX: 10;

declare const REWIND_RATE_LIMIT_WINDOW_MS: number;

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/**
 * Evaluate caller-scoped rewind quota for one run.
 *
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   caller: string;
 *   nowMs?: () => number;
 *   maxPerWindow?: number;
 *   windowMs?: number;
 * }} input
 */
declare function evaluateRewindRateLimit(input: {
    adapter: SmithersDb$5;
    runId: string;
    caller: string;
    nowMs?: () => number;
    maxPerWindow?: number;
    windowMs?: number;
}): Promise<{
    limited: boolean;
    used: number;
    remaining: number;
    max: number;
    windowMs: number;
    windowStartedAtMs: number;
}>;
type SmithersDb$5 = _smithers_db_adapter.SmithersDb;

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */
/**
 * Persist one audit row for a jump-to-frame attempt.
 *
 * @param {SmithersDb} adapter
 * @param {{
 *   runId: string;
 *   fromFrameNo: number;
 *   toFrameNo: number;
 *   caller: string;
 *   timestampMs: number;
 *   result: RewindAuditResult;
 *   durationMs?: number | null;
 * }} row
 * @returns {Promise<number | null>}
 */
declare function writeRewindAuditRow(adapter: SmithersDb$4, row: {
    runId: string;
    fromFrameNo: number;
    toFrameNo: number;
    caller: string;
    timestampMs: number;
    result: RewindAuditResult$3;
    durationMs?: number | null;
}): Promise<number | null>;
type SmithersDb$4 = _smithers_db_adapter.SmithersDb;
type RewindAuditResult$3 = RewindAuditResult$4;

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */
/**
 * Update an existing rewind audit row's result and duration.
 * Used to mark an `in_progress` row as `success`, `failed`, or `partial`.
 *
 * @param {SmithersDb} adapter
 * @param {{ id: number; result: RewindAuditResult; durationMs?: number | null; fromFrameNo?: number }} row
 */
declare function updateRewindAuditRow(adapter: SmithersDb$3, row: {
    id: number;
    result: RewindAuditResult$2;
    durationMs?: number | null;
    fromFrameNo?: number;
}): Promise<void>;
type SmithersDb$3 = _smithers_db_adapter.SmithersDb;
type RewindAuditResult$2 = RewindAuditResult$4;

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/**
 * Count audit rows for one caller and run in a time window.
 * Only counts terminal (non-in_progress) rows so that a live attempt
 * does not itself blow the rate-limit quota.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId: string; caller: string; sinceMs: number; }} input
 * @returns {Promise<number>}
 */
declare function countRecentRewindAuditRows(adapter: SmithersDb$2, input: {
    runId: string;
    caller: string;
    sinceMs: number;
}): Promise<number>;
type SmithersDb$2 = _smithers_db_adapter.SmithersDb;

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */
/**
 * Fetch audit rows for tests and diagnostics.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId?: string; limit?: number; }} [input]
 * @returns {Promise<Array<{ id: number; runId: string; fromFrameNo: number; toFrameNo: number; caller: string; timestampMs: number; result: RewindAuditResult; durationMs: number | null }>>}
 */
declare function listRewindAuditRows(adapter: SmithersDb$1, input?: {
    runId?: string;
    limit?: number;
}): Promise<Array<{
    id: number;
    runId: string;
    fromFrameNo: number;
    toFrameNo: number;
    caller: string;
    timestampMs: number;
    result: RewindAuditResult$1;
    durationMs: number | null;
}>>;
type SmithersDb$1 = _smithers_db_adapter.SmithersDb;
type RewindAuditResult$1 = RewindAuditResult$4;

/** @typedef {import("@smithers/db/adapter").SmithersDb} SmithersDb */
/**
 * On startup, find rewind audit rows left in `in_progress` by a prior crash,
 * mark them as `partial`, and flag the associated runs as `needs_attention`.
 *
 * @param {SmithersDb} adapter
 * @param {{ nowMs?: () => number }} [options]
 * @returns {Promise<{ recovered: Array<{ id: number; runId: string }> }>}
 */
declare function recoverInProgressRewindAudits(adapter: SmithersDb, options?: {
    nowMs?: () => number;
}): Promise<{
    recovered: Array<{
        id: number;
        runId: string;
    }>;
}>;
type SmithersDb = _smithers_db_adapter.SmithersDb;

type BranchInfo$1 = BranchInfo$2;
type ForkParams = ForkParams$1;
type NodeChange = NodeChange$1;
type NodeSnapshot = NodeSnapshot$1;
type OutputChange = OutputChange$1;
type ParsedSnapshot = ParsedSnapshot$2;
type RalphChange = RalphChange$1;
type RalphSnapshot = RalphSnapshot$1;
type ReplayParams = ReplayParams$1;
type ReplayResult = ReplayResult$1;
type RunTimeline = RunTimeline$1;
type Snapshot$1 = Snapshot$3;
type SnapshotData = SnapshotData$1;
type SnapshotDiff = SnapshotDiff$1;
type TimelineFrame = TimelineFrame$1;
type TimelineTree = TimelineTree$3;
type VcsTag = VcsTag$1;
type JumpResult = JumpResult$2;
type JumpToFrameInput = JumpToFrameInput$2;
type JumpStepName = JumpStepName$1;
type RewindLockHandle = RewindLockHandle$2;
type RewindAuditResult = RewindAuditResult$4;

export { type BranchInfo$1 as BranchInfo, type ForkParams, type JumpResult, type JumpStepName, JumpToFrameError, type JumpToFrameInput, type NodeChange, type NodeSnapshot, type OutputChange, type ParsedSnapshot, REWIND_RATE_LIMIT_MAX, REWIND_RATE_LIMIT_WINDOW_MS, type RalphChange, type RalphSnapshot, type ReplayParams, type ReplayResult, type RewindAuditResult, type RewindLockHandle, type RunTimeline, type Snapshot$1 as Snapshot, type SnapshotData, type SnapshotDiff, type TimelineFrame, type TimelineTree, type VcsTag, acquireRewindLock, buildTimeline, buildTimelineTree, captureSnapshot, countRecentRewindAuditRows, diffRawSnapshots, diffSnapshots, evaluateRewindRateLimit, forkRun, formatDiffAsJson, formatDiffForTui, formatTimelineAsJson, formatTimelineForTui, getBranchInfo, hasRewindLock, jumpToFrame, listBranches, listRewindAuditRows, listSnapshots, loadLatestSnapshot, loadSnapshot, loadVcsTag, parseSnapshot, recoverInProgressRewindAudits, replayFromCheckpoint, replaysStarted, rerunAtRevision, resetRewindLocksForTests, resolveWorkflowAtRevision, runForksCreated, smithersBranches, smithersSnapshots, smithersVcsTags, snapshotDuration, snapshotsCaptured, tagSnapshotVcs, updateRewindAuditRow, validateJumpFrameNo, validateJumpRunId, writeRewindAuditRow };
