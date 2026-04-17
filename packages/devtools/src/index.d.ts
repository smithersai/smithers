type SmithersNodeType$2 = "workflow" | "task" | "sequence" | "parallel" | "merge-queue" | "branch" | "loop" | "worktree" | "approval" | "timer" | "subflow" | "wait-for-event" | "saga" | "try-catch" | "fragment" | "unknown";

type DevToolsNode$7 = {
    id: number;
    /** Smithers-level type: "workflow" | "task" | "sequence" | etc. */
    type: SmithersNodeType$2;
    /** Display name (component function name or host tag) */
    name: string;
    /** Props snapshot (serializable subset) */
    props: Record<string, unknown>;
    /** Task-specific fields extracted from renderer raw props */
    task?: {
        nodeId: string;
        kind: "agent" | "compute" | "static";
        agent?: string;
        label?: string;
        outputTableName?: string;
        iteration?: number;
    };
    children: DevToolsNode$7[];
    /** Depth in the Smithers tree (not renderer tree depth) */
    depth: number;
};

type DevToolsDeltaOp$1 = {
    op: "addNode";
    parentId: number;
    index: number;
    node: DevToolsNode$7;
} | {
    op: "removeNode";
    id: number;
} | {
    op: "updateProps";
    id: number;
    props: Record<string, unknown>;
} | {
    op: "updateTask";
    id: number;
    task: DevToolsNode$7["task"];
} | {
    op: "replaceRoot";
    node: DevToolsNode$7;
};

type DevToolsDelta$3 = {
    version: 1;
    baseSeq: number;
    seq: number;
    ops: DevToolsDeltaOp$1[];
};

type DevToolsSnapshotV1$3 = {
    version: 1;
    runId: string;
    frameNo: number;
    seq: number;
    root: DevToolsNode$7;
};

type SnapshotSerializerWarning$1 = {
    code: "CircularReference" | "MaxDepthExceeded" | "MaxEntriesExceeded" | "UnsupportedType";
    path: string;
    detail?: string;
};

type SnapshotSerializerOptions$2 = {
    maxDepth?: number;
    maxEntries?: number;
    onWarning?: (warning: SnapshotSerializerWarning$1) => void;
};

/** Execution state for a task, derived from SmithersEvent stream */
type TaskExecutionState$3 = {
    nodeId: string;
    iteration: number;
    status: "pending" | "started" | "finished" | "failed" | "cancelled" | "skipped" | "waiting-approval" | "waiting-event" | "waiting-timer" | "retrying";
    attempt: number;
    startedAt?: number;
    finishedAt?: number;
    error?: unknown;
    toolCalls: Array<{
        name: string;
        seq: number;
        status?: "success" | "error";
    }>;
};

type RunState = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "recovering" | "stale" | "orphaned" | "failed" | "cancelled" | "succeeded" | "unknown";
type ReasonBlocked = {
    kind: "approval";
    nodeId: string;
    requestedAt: string;
} | {
    kind: "event";
    nodeId: string;
    correlationKey: string;
} | {
    kind: "timer";
    nodeId: string;
    wakeAt: string;
} | {
    kind: "provider";
    nodeId: string;
    code: "rate-limit" | "auth" | "timeout";
} | {
    kind: "tool";
    nodeId: string;
    toolName: string;
    code: string;
};
type ReasonUnhealthy = {
    kind: "engine-heartbeat-stale";
    lastHeartbeatAt: string;
} | {
    kind: "ui-heartbeat-stale";
    lastSeenAt: string;
} | {
    kind: "db-lock";
} | {
    kind: "sandbox-unreachable";
} | {
    kind: "supervisor-backoff";
    attempt: number;
    nextAt: string;
};
type RunStateView = {
    runId: string;
    state: RunState;
    blocked?: ReasonBlocked;
    unhealthy?: ReasonUnhealthy;
    computedAt: string;
};
type DevToolsSnapshot$3 = {
    tree: DevToolsNode$7 | null;
    nodeCount: number;
    taskCount: number;
    timestamp: number;
    runState?: RunStateView;
};

type DevToolsEventHandler$1 = (event: "commit" | "unmount", snapshot: DevToolsSnapshot$3) => void;

type SmithersDevToolsOptions$2 = {
    /** Called on every renderer commit that touches the Smithers tree */
    onCommit?: DevToolsEventHandler$1;
    /** Called on every SmithersEvent from an attached EventBus */
    onEngineEvent?: (event: any) => void;
    /** Enable verbose console logging */
    verbose?: boolean;
};

/** Execution state for a run, aggregated from SmithersEvent stream */
type RunExecutionState$3 = {
    runId: string;
    status: "running" | "finished" | "failed" | "cancelled" | "waiting-approval" | "waiting-timer";
    frameNo: number;
    tasks: Map<string, TaskExecutionState$3>;
    events: Array<{
        type: string;
        timestampMs: number;
        [key: string]: unknown;
    }>;
    startedAt?: number;
    finishedAt?: number;
};

type DevToolsRunStoreOptions$2 = Pick<SmithersDevToolsOptions$2, "onEngineEvent" | "verbose">;

type DevToolsEventBus$3 = {
    on: (event: "event", handler: (e: any) => void) => void;
    removeListener: (event: "event", handler: (e: any) => void) => void;
};

/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/**
 * @param {DevToolsNode} node
 * @returns {{ nodes: number; tasks: number }}
 */
declare function countNodes(node: DevToolsNode$6): {
    nodes: number;
    tasks: number;
};
type DevToolsNode$6 = DevToolsNode$7;

/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./DevToolsSnapshot.ts").DevToolsSnapshot} DevToolsSnapshot */
/**
 * @param {DevToolsNode | null} root
 * @returns {DevToolsSnapshot}
 */
declare function buildSnapshot(root: DevToolsNode$5 | null): DevToolsSnapshot$2;
type DevToolsNode$5 = DevToolsNode$7;
type DevToolsSnapshot$2 = DevToolsSnapshot$3;

/** @typedef {import("./SmithersNodeType.ts").SmithersNodeType} SmithersNodeType */
/** @type {Record<SmithersNodeType, string>} */
declare const SMITHERS_NODE_ICONS: Record<SmithersNodeType$1, string>;
type SmithersNodeType$1 = SmithersNodeType$2;

/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/**
 * @param {DevToolsNode} node
 * @param {string} [indent]
 * @returns {string}
 */
declare function printTree(node: DevToolsNode$4, indent?: string): string;
type DevToolsNode$4 = DevToolsNode$7;

/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/**
 * @param {DevToolsNode} node
 * @param {string} nodeId
 * @returns {DevToolsNode | null}
 */
declare function findNodeById(node: DevToolsNode$3, nodeId: string): DevToolsNode$3 | null;
type DevToolsNode$3 = DevToolsNode$7;

/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/**
 * @param {DevToolsNode} node
 * @param {DevToolsNode[]} [out]
 * @returns {DevToolsNode[]}
 */
declare function collectTasks(node: DevToolsNode$2, out?: DevToolsNode$2[]): DevToolsNode$2[];
type DevToolsNode$2 = DevToolsNode$7;

/** @typedef {import("./DevToolsEventBus.ts").DevToolsEventBus} DevToolsEventBus */
/** @typedef {import("./DevToolsRunStoreOptions.ts").DevToolsRunStoreOptions} DevToolsRunStoreOptions */
/** @typedef {import("./RunExecutionState.ts").RunExecutionState} RunExecutionState */
/** @typedef {import("./TaskExecutionState.ts").TaskExecutionState} TaskExecutionState */
declare class DevToolsRunStore {
    /**
     * @param {DevToolsRunStoreOptions} [options]
     */
    constructor(options?: DevToolsRunStoreOptions$1);
    /** @type {DevToolsRunStoreOptions} */
    options: DevToolsRunStoreOptions$1;
    /** @type {Map<string, RunExecutionState>} */
    _runs: Map<string, RunExecutionState$2>;
    /** @type {Array<{ bus: DevToolsEventBus; handler: (event: any) => void }>} */
    _eventBusListeners: Array<{
        bus: DevToolsEventBus$2;
        handler: (event: any) => void;
    }>;
    /**
     * Attach to a Smithers EventBus-like source.
     * @param {DevToolsEventBus} bus
     * @returns {this}
     */
    attachEventBus(bus: DevToolsEventBus$2): this;
    /** Detach all EventBus listeners registered by this store. */
    detachEventBuses(): void;
    /**
     * Get execution state for a specific run.
     * @param {string} runId
     * @returns {RunExecutionState | undefined}
     */
    getRun(runId: string): RunExecutionState$2 | undefined;
    /**
     * Get all tracked runs.
     * @returns {Map<string, RunExecutionState>}
     */
    get runs(): Map<string, RunExecutionState$2>;
    /**
     * Get task execution state by nodeId within a run. Searches all iterations.
     * @param {string} runId
     * @param {string} nodeId
     * @param {number} [iteration]
     * @returns {TaskExecutionState | undefined}
     */
    getTaskState(runId: string, nodeId: string, iteration?: number): TaskExecutionState$2 | undefined;
    /**
     * @param {any} event
     */
    processEngineEvent(event: any): void;
    /**
     * @param {string} runId
     * @returns {RunExecutionState}
     */
    ensureRun(runId: string): RunExecutionState$2;
    /**
     * @param {RunExecutionState} run
     * @param {string} nodeId
     * @param {number} iteration
     * @returns {TaskExecutionState}
     */
    ensureTask(run: RunExecutionState$2, nodeId: string, iteration: number): TaskExecutionState$2;
}
type DevToolsEventBus$2 = DevToolsEventBus$3;
type DevToolsRunStoreOptions$1 = DevToolsRunStoreOptions$2;
type RunExecutionState$2 = RunExecutionState$3;
type TaskExecutionState$2 = TaskExecutionState$3;

/** @typedef {import("./DevToolsEventBus.ts").DevToolsEventBus} DevToolsEventBus */
/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./DevToolsSnapshot.ts").DevToolsSnapshot} DevToolsSnapshot */
/** @typedef {import("./RunExecutionState.ts").RunExecutionState} RunExecutionState */
/** @typedef {import("./SmithersDevToolsOptions.ts").SmithersDevToolsOptions} SmithersDevToolsOptions */
/** @typedef {import("./TaskExecutionState.ts").TaskExecutionState} TaskExecutionState */
declare class SmithersDevToolsCore {
    /**
     * @param {SmithersDevToolsOptions} [options]
     */
    constructor(options?: SmithersDevToolsOptions$1);
    /** @type {SmithersDevToolsOptions} */
    options: SmithersDevToolsOptions$1;
    /** @type {DevToolsSnapshot | null} */
    _lastSnapshot: DevToolsSnapshot$1 | null;
    /** @type {DevToolsRunStore} */
    _runStore: DevToolsRunStore;
    /**
     * @param {DevToolsNode | null} tree
     * @returns {DevToolsSnapshot}
     */
    captureSnapshot(tree: DevToolsNode$1 | null): DevToolsSnapshot$1;
    /**
     * @param {DevToolsSnapshot} [snapshot]
     * @returns {DevToolsSnapshot}
     */
    emitCommit(snapshot?: DevToolsSnapshot$1): DevToolsSnapshot$1;
    /**
     * @param {DevToolsNode | null} tree
     * @returns {DevToolsSnapshot}
     */
    captureCommit(tree: DevToolsNode$1 | null): DevToolsSnapshot$1;
    /**
     * @param {DevToolsSnapshot} [snapshot]
     * @returns {DevToolsSnapshot}
     */
    emitUnmount(snapshot?: DevToolsSnapshot$1): DevToolsSnapshot$1;
    /**
     * @param {DevToolsEventBus} bus
     * @returns {this}
     */
    attachEventBus(bus: DevToolsEventBus$1): this;
    detachEventBuses(): void;
    /**
     * @param {any} event
     */
    processEngineEvent(event: any): void;
    /**
     * @param {string} runId
     * @returns {RunExecutionState | undefined}
     */
    getRun(runId: string): RunExecutionState$1 | undefined;
    /**
     * @returns {Map<string, RunExecutionState>}
     */
    get runs(): Map<string, RunExecutionState$1>;
    /**
     * @param {string} runId
     * @param {string} nodeId
     * @param {number} [iteration]
     * @returns {TaskExecutionState | undefined}
     */
    getTaskState(runId: string, nodeId: string, iteration?: number): TaskExecutionState$1 | undefined;
    /**
     * Get the last captured snapshot.
     * @returns {DevToolsSnapshot | null}
     */
    get snapshot(): DevToolsSnapshot$1 | null;
    /**
     * Get the current tree (shorthand).
     * @returns {DevToolsNode | null}
     */
    get tree(): DevToolsNode$1 | null;
    /**
     * Pretty-print the current tree to a string.
     * @returns {string}
     */
    printTree(): string;
    /**
     * Find a node by task nodeId.
     * @param {string} nodeId
     * @returns {DevToolsNode | null}
     */
    findTask(nodeId: string): DevToolsNode$1 | null;
    /**
     * List all tasks in the current tree.
     * @returns {DevToolsNode[]}
     */
    listTasks(): DevToolsNode$1[];
}
type DevToolsEventBus$1 = DevToolsEventBus$3;
type DevToolsNode$1 = DevToolsNode$7;
type DevToolsSnapshot$1 = DevToolsSnapshot$3;
type RunExecutionState$1 = RunExecutionState$3;
type SmithersDevToolsOptions$1 = SmithersDevToolsOptions$2;
type TaskExecutionState$1 = TaskExecutionState$3;

/**
 * Serialize arbitrary values into a stable JSON-safe shape for devtools snapshots.
 *
 * @param {unknown} value
 * @param {SnapshotSerializerOptions} [options]
 * @returns {unknown}
 */
declare function snapshotSerialize(value: unknown, options?: SnapshotSerializerOptions$1): unknown;
type SnapshotSerializerOptions$1 = SnapshotSerializerOptions$2;

/** @type {number} */
declare const SNAPSHOT_SERIALIZER_DEFAULT_MAX_DEPTH: number;

/**
 * Compute a delta from snapshot `a` to snapshot `b`.
 *
 * @param {DevToolsSnapshotV1} a
 * @param {DevToolsSnapshotV1} b
 * @returns {DevToolsDelta}
 */
declare function diffSnapshots(a: DevToolsSnapshotV1$2, b: DevToolsSnapshotV1$2): DevToolsDelta$2;
type DevToolsDelta$2 = DevToolsDelta$3;
type DevToolsSnapshotV1$2 = DevToolsSnapshotV1$3;

/**
 * Apply a delta to a snapshot. Throws `InvalidDeltaError` for malformed ops.
 *
 * @param {DevToolsSnapshotV1} snapshot
 * @param {DevToolsDelta} delta
 * @returns {DevToolsSnapshotV1}
 */
declare function applyDelta(snapshot: DevToolsSnapshotV1$1, delta: DevToolsDelta$1): DevToolsSnapshotV1$1;
type DevToolsDelta$1 = DevToolsDelta$3;
type DevToolsSnapshotV1$1 = DevToolsSnapshotV1$3;

declare class InvalidDeltaError extends Error {
    /**
     * @param {string} message
     */
    constructor(message: string);
    /** @type {"InvalidDelta"} */
    code: "InvalidDelta";
}

type DevToolsEventBus = DevToolsEventBus$3;
type DevToolsEventHandler = DevToolsEventHandler$1;
type DevToolsNode = DevToolsNode$7;
type DevToolsRunStoreOptions = DevToolsRunStoreOptions$2;
type DevToolsSnapshot = DevToolsSnapshot$3;
type RunExecutionState = RunExecutionState$3;
type SmithersDevToolsOptions = SmithersDevToolsOptions$2;
type SmithersNodeType = SmithersNodeType$2;
type TaskExecutionState = TaskExecutionState$3;
type SnapshotSerializerOptions = SnapshotSerializerOptions$2;
type SnapshotSerializerWarning = SnapshotSerializerWarning$1;
type DevToolsSnapshotV1 = DevToolsSnapshotV1$3;
type DevToolsDelta = DevToolsDelta$3;
type DevToolsDeltaOp = DevToolsDeltaOp$1;

export { type DevToolsDelta, type DevToolsDeltaOp, type DevToolsEventBus, type DevToolsEventHandler, type DevToolsNode, DevToolsRunStore, type DevToolsRunStoreOptions, type DevToolsSnapshot, type DevToolsSnapshotV1, InvalidDeltaError, type RunExecutionState, SMITHERS_NODE_ICONS, SNAPSHOT_SERIALIZER_DEFAULT_MAX_DEPTH, SmithersDevToolsCore, type SmithersDevToolsOptions, type SmithersNodeType, type SnapshotSerializerOptions, type SnapshotSerializerWarning, type TaskExecutionState, applyDelta, buildSnapshot, collectTasks, countNodes, diffSnapshots, findNodeById, printTree, snapshotSerialize };
