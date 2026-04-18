import * as _smithers_components_SmithersWorkflow from '@smithers/components/SmithersWorkflow';
import { SmithersWorkflow as SmithersWorkflow$2 } from '@smithers/components/SmithersWorkflow';
import * as _smithers_scheduler_SmithersWorkflowOptions from '@smithers/scheduler/SmithersWorkflowOptions';
import * as _smithers_db_adapter from '@smithers/db/adapter';
import { SmithersDb } from '@smithers/db/adapter';
import * as effect from 'effect';
import { Schema, Effect, Layer, ManagedRuntime, Exit, Scope } from 'effect';
import * as _smithers_errors_SmithersError from '@smithers/errors/SmithersError';
import { SmithersError } from '@smithers/errors/SmithersError';
import * as _smithers_driver_RunResult from '@smithers/driver/RunResult';
import * as _smithers_observability_SmithersEvent from '@smithers/observability/SmithersEvent';
import * as _smithers_observability_correlation from '@smithers/observability/correlation';
import { EventEmitter } from 'node:events';
import * as _smithers_graph_XmlNode from '@smithers/graph/XmlNode';
import * as _smithers_graph_TaskDescriptor from '@smithers/graph/TaskDescriptor';
import { TaskDescriptor } from '@smithers/graph/TaskDescriptor';
import * as _smithers_scheduler from '@smithers/scheduler';
export { Scheduler, SchedulerLive, buildStateKey, cloneTaskStateMap, isTerminalState, parseStateKey } from '@smithers/scheduler';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';
import { SQLiteTable as SQLiteTable$1 } from 'drizzle-orm/sqlite-core';
import * as drizzle_orm_bun_sqlite from 'drizzle-orm/bun-sqlite';
import { BunSQLiteDatabase as BunSQLiteDatabase$3 } from 'drizzle-orm/bun-sqlite';
import { TaskAborted } from '@smithers/errors/TaskAborted';
import * as _smithers_scheduler_RetryPolicy from '@smithers/scheduler/RetryPolicy';
import { RetryPolicy as RetryPolicy$1 } from '@smithers/scheduler/RetryPolicy';
import { CachePolicy } from '@smithers/scheduler/CachePolicy';
import * as _smithers_driver_RunOptions from '@smithers/driver/RunOptions';
import * as _smithers_graph_GraphSnapshot from '@smithers/graph/GraphSnapshot';
import { SmithersCtx } from '@smithers/driver/SmithersCtx';
import * as _smithers_errors_toSmithersError from '@smithers/errors/toSmithersError';
import { Database } from 'bun:sqlite';

type ChildWorkflowDefinition$1 = SmithersWorkflow$2<unknown> | (() => SmithersWorkflow$2<unknown> | unknown);

type AlertHumanRequestOptions$1 = {
    runId: string;
    nodeId: string;
    iteration: number;
    kind: "ask" | "confirm" | "select" | "json";
    prompt: string;
    linkedAlertId?: string;
};

type AlertRuntimeServices$1 = {
    runId: string;
    adapter: unknown;
    eventBus: unknown;
    requestCancel: () => void;
    createHumanRequest: (options: AlertHumanRequestOptions$1) => Promise<void>;
    pauseScheduler: (reason: string) => void;
};

/** @typedef {import("./AlertHumanRequestOptions.ts").AlertHumanRequestOptions} AlertHumanRequestOptions */
/** @typedef {import("./AlertRuntimeServices.ts").AlertRuntimeServices} AlertRuntimeServices */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
declare class AlertRuntime {
    /**
   * @param {SmithersAlertPolicy} policy
   * @param {AlertRuntimeServices} services
   */
    constructor(policy: SmithersAlertPolicy, services: AlertRuntimeServices);
    /** @type {SmithersAlertPolicy} */
    policy: SmithersAlertPolicy;
    /** @type {AlertRuntimeServices} */
    services: AlertRuntimeServices;
    start(): void;
    stop(): void;
}
type AlertHumanRequestOptions = AlertHumanRequestOptions$1;
type AlertRuntimeServices = AlertRuntimeServices$1;
type SmithersAlertPolicy = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertPolicy;

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} [note]
 * @param {string} [decidedBy]
 * @param {unknown} [decision]
 * @param {boolean} [autoApproved]
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
declare function approveNode(adapter: SmithersDb, runId: string, nodeId: string, iteration: number, note?: string, decidedBy?: string, decision?: unknown, autoApproved?: boolean): Effect.Effect<void, SmithersError, never>;
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @param {string} [note]
 * @param {string} [decidedBy]
 * @param {unknown} [decision]
 * @returns {Effect.Effect<void, SmithersError, never>}
 */
declare function denyNode(adapter: SmithersDb, runId: string, nodeId: string, iteration: number, note?: string, decidedBy?: string, decision?: unknown): Effect.Effect<void, SmithersError, never>;

type ChildWorkflowExecuteOptions$1 = {
    workflow: ChildWorkflowDefinition$1;
    input?: unknown;
    runId?: string;
    parentRunId?: string;
    rootDir?: string;
    allowNetwork?: boolean;
    maxOutputBytes?: number;
    toolTimeoutMs?: number;
    workflowPath?: string;
    signal?: AbortSignal;
};

/**
 * @param {import("@smithers/components/SmithersWorkflow").SmithersWorkflow<any> | undefined} parentWorkflow
 * @param {ChildWorkflowExecuteOptions} options
 * @returns {Promise<{ runId: string; status: RunResult["status"]; output: unknown; }>}
 */
declare function executeChildWorkflow(parentWorkflow: _smithers_components_SmithersWorkflow.SmithersWorkflow<any> | undefined, options: ChildWorkflowExecuteOptions): Promise<{
    runId: string;
    status: RunResult$2["status"];
    output: unknown;
}>;
type ChildWorkflowExecuteOptions = ChildWorkflowExecuteOptions$1;
type RunResult$2 = _smithers_driver_RunResult.RunResult;

/** @typedef {import("@smithers/observability/correlation").CorrelationContext} CorrelationContext */
/**
 * @typedef {SmithersEvent & { correlation?: CorrelationContext; }} CorrelatedSmithersEvent
 */
/** @typedef {import("@smithers/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} _BunSQLiteDatabase */
declare class EventBus extends EventEmitter<any> {
    /**
   * @param {{ db?: BunSQLiteDatabase; logDir?: string; startSeq?: number }} opts
   */
    constructor(opts: {
        db?: BunSQLiteDatabase;
        logDir?: string;
        startSeq?: number;
    });
    seq: number;
    logDir: string | undefined;
    db: any;
    persistTail: Promise<void>;
    persistError: null;
    /**
   * @param {SmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    emitEvent(event: SmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {SmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    emitEventWithPersist(event: SmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {SmithersEvent} event
   * @returns {Promise<void>}
   */
    emitEventQueued(event: SmithersEvent): Promise<void>;
    /**
   * @returns {Effect.Effect<void, unknown>}
   */
    flush(): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    persist(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    emitAndTrack(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    enqueuePersist(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    persistDb(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {string} label
   * @param {(row: any) => unknown} method
   * @param {any} row
   * @returns {Effect.Effect<void, unknown>}
   */
    callDbPersistence(label: string, method: (row: any) => unknown, row: any): Effect.Effect<void, unknown>;
    /**
   * @param {CorrelatedSmithersEvent} event
   * @returns {Effect.Effect<void, unknown>}
   */
    persistLog(event: CorrelatedSmithersEvent): Effect.Effect<void, unknown>;
    /**
   * @param {SmithersEvent} event
   * @returns {CorrelatedSmithersEvent}
   */
    attachCorrelation(event: SmithersEvent): CorrelatedSmithersEvent;
    /**
   * @param {CorrelatedSmithersEvent} event
   */
    eventLogAnnotations(event: CorrelatedSmithersEvent): {
        runId: string;
        eventType: "SupervisorStarted" | "SupervisorPollCompleted" | "RunAutoResumed" | "RunAutoResumeSkipped" | "RunStarted" | "RunStatusChanged" | "RunStateChanged" | "RunFinished" | "RunFailed" | "RunCancelled" | "RunContinuedAsNew" | "RunHijackRequested" | "RunHijacked" | "SandboxCreated" | "SandboxShipped" | "SandboxHeartbeat" | "SandboxBundleReceived" | "SandboxCompleted" | "SandboxFailed" | "SandboxDiffReviewRequested" | "SandboxDiffAccepted" | "SandboxDiffRejected" | "FrameCommitted" | "NodePending" | "NodeStarted" | "TaskHeartbeat" | "TaskHeartbeatTimeout" | "NodeFinished" | "NodeFailed" | "NodeCancelled" | "NodeSkipped" | "NodeRetrying" | "NodeWaitingApproval" | "NodeWaitingTimer" | "ApprovalRequested" | "ApprovalGranted" | "ApprovalAutoApproved" | "ApprovalDenied" | "ToolCallStarted" | "ToolCallFinished" | "NodeOutput" | "AgentEvent" | "RetryTaskStarted" | "RetryTaskFinished" | "RevertStarted" | "RevertFinished" | "TimeTravelStarted" | "TimeTravelFinished" | "TimeTravelJumped" | "WorkflowReloadDetected" | "WorkflowReloaded" | "WorkflowReloadFailed" | "WorkflowReloadUnsafe" | "ScorerStarted" | "ScorerFinished" | "ScorerFailed" | "TokenUsageReported" | "SnapshotCaptured" | "RunForked" | "ReplayStarted" | "MemoryFactSet" | "MemoryRecalled" | "MemoryMessageSaved" | "OpenApiToolCalled" | "TimerCreated" | "TimerFired" | "TimerCancelled";
    };
}
type CorrelationContext = _smithers_observability_correlation.CorrelationContext;
type CorrelatedSmithersEvent = SmithersEvent & {
    correlation?: CorrelationContext;
};
type SmithersEvent = _smithers_observability_SmithersEvent.SmithersEvent;

/**
 * @param {unknown} value
 * @returns {| { name: string; sideEffect: boolean; idempotent: boolean; } | null}
 */
declare function getDefinedToolMetadata(value: unknown): {
    name: string;
    sideEffect: boolean;
    idempotent: boolean;
} | null;

type HumanRequestStatus$1 = "pending" | "answered" | "cancelled" | "expired";

type HumanRequestKind$1 = "ask" | "confirm" | "select" | "json";

/**
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
declare function buildHumanRequestId(runId: string, nodeId: string, iteration: number): string;
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @returns {boolean}
 */
declare function isHumanTaskMeta(meta: Record<string, unknown> | null | undefined): boolean;
/**
 * @param {Record<string, unknown> | null | undefined} meta
 * @param {string} fallback
 * @returns {string}
 */
declare function getHumanTaskPrompt(meta: Record<string, unknown> | null | undefined, fallback: string): string;
/**
 * @param {{ timeoutAtMs?: number | null } | null | undefined} request
 * @returns {boolean}
 */
declare function isHumanRequestPastTimeout(request: {
    timeoutAtMs?: number | null;
} | null | undefined, nowMs?: number): boolean;
/**
 * @param {{ requestId: string; schemaJson: string | null }} request
 * @param {unknown} value
 * @returns {HumanRequestSchemaValidation}
 */
declare function validateHumanRequestValue(request: {
    requestId: string;
    schemaJson: string | null;
}, value: unknown): HumanRequestSchemaValidation;
/**
 * @typedef {{ ok: true; } | { ok: false; code: "HUMAN_REQUEST_SCHEMA_INVALID" | "HUMAN_REQUEST_VALIDATION_FAILED"; message: string; }} HumanRequestSchemaValidation
 */
/** @type {readonly ["ask", "confirm", "select", "json"]} */
declare const HUMAN_REQUEST_KINDS: readonly ["ask", "confirm", "select", "json"];
/** @type {readonly ["pending", "answered", "cancelled", "expired"]} */
declare const HUMAN_REQUEST_STATUSES: readonly ["pending", "answered", "cancelled", "expired"];
type HumanRequestKind = HumanRequestKind$1;
type HumanRequestStatus = HumanRequestStatus$1;
type HumanRequestSchemaValidation = {
    ok: true;
} | {
    ok: false;
    code: "HUMAN_REQUEST_SCHEMA_INVALID" | "HUMAN_REQUEST_VALIDATION_FAILED";
    message: string;
};

/**
 * @param {string | null | undefined} runtimeOwnerId
 * @returns {number | null}
 */
declare function parseRuntimeOwnerPid(runtimeOwnerId: string | null | undefined): number | null;
/**
 * @param {number} pid
 * @returns {boolean}
 */
declare function isPidAlive(pid: number): boolean;

type RalphMeta$1 = {
    id: string;
    until: boolean;
    maxIterations: number;
    onMaxReached: "fail" | "return-last";
    continueAsNewEvery?: number;
};

type ContinuationRequest$1 = {
    stateJson?: string;
};

type ScheduleResult$1 = {
    runnable: TaskDescriptor[];
    pendingExists: boolean;
    waitingApprovalExists: boolean;
    waitingEventExists: boolean;
    waitingTimerExists: boolean;
    readyRalphs: RalphMeta$1[];
    continuation?: ContinuationRequest$1;
    nextRetryAtMs?: number;
    fatalError?: string;
};

type RalphState$1 = {
    iteration: number;
    done: boolean;
};

type RalphStateMap$1 = Map<string, RalphState$1>;

type PlanNode$1 = {
    kind: "task";
    nodeId: string;
} | {
    kind: "sequence";
    children: PlanNode$1[];
} | {
    kind: "parallel";
    children: PlanNode$1[];
} | {
    kind: "ralph";
    id: string;
    children: PlanNode$1[];
    until: boolean;
    maxIterations: number;
    onMaxReached: "fail" | "return-last";
    continueAsNewEvery?: number;
} | {
    kind: "continue-as-new";
    stateJson?: string;
} | {
    kind: "group";
    children: PlanNode$1[];
} | {
    kind: "saga";
    id: string;
    actionChildren: PlanNode$1[];
    compensationChildren: PlanNode$1[];
    onFailure: "compensate" | "compensate-and-fail" | "fail";
} | {
    kind: "try-catch-finally";
    id: string;
    tryChildren: PlanNode$1[];
    catchChildren: PlanNode$1[];
    finallyChildren: PlanNode$1[];
};

/**
 * @type {(xml: XmlNode | null, ralphState?: RalphStateMap) => { plan: PlanNode | null; ralphs: RalphMeta[] }}
 */
declare const buildPlanTree: (xml: XmlNode | null, ralphState?: RalphStateMap) => {
    plan: PlanNode | null;
    ralphs: RalphMeta[];
};
/**
 * @type {(plan: PlanNode | null, states: TaskStateMap, descriptors: Map<string, _TaskDescriptor>, ralphState: RalphStateMap, retryWait: Map<string, number>, nowMs: number) => ScheduleResult}
 */
declare const scheduleTasks: (plan: PlanNode | null, states: TaskStateMap, descriptors: Map<string, _TaskDescriptor$6>, ralphState: RalphStateMap, retryWait: Map<string, number>, nowMs: number) => ScheduleResult;
type ContinuationRequest = ContinuationRequest$1;
type PlanNode = PlanNode$1;
type RalphMeta = RalphMeta$1;
type RalphState = RalphState$1;
type RalphStateMap = RalphStateMap$1;
type ReadonlyTaskStateMap = _smithers_scheduler.ReadonlyTaskStateMap;
type RetryWaitMap = _smithers_scheduler.RetryWaitMap;
type ScheduleResult = ScheduleResult$1;
type ScheduleSnapshot = _smithers_scheduler.ScheduleSnapshot;
type TaskRecord = _smithers_scheduler.TaskRecord;
type TaskState = _smithers_scheduler.TaskState;
type TaskStateMap = _smithers_scheduler.TaskStateMap;
type _TaskDescriptor$6 = _smithers_graph_TaskDescriptor.TaskDescriptor;
type XmlNode = _smithers_graph_XmlNode.XmlNode;

type SignalRunOptions$1 = {
    correlationId?: string | null;
    receivedBy?: string | null;
    timestampMs?: number;
};

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} signalName
 * @param {unknown} payload
 * @param {SignalRunOptions} [options]
 * @returns {Effect.Effect<{ runId: string; seq: number; signalName: string; correlationId: string | null; receivedAtMs: number }, SmithersError, never>}
 */
declare function signalRun(adapter: SmithersDb, runId: string, signalName: string, payload: unknown, options?: SignalRunOptions): Effect.Effect<{
    runId: string;
    seq: number;
    signalName: string;
    correlationId: string | null;
    receivedAtMs: number;
}, SmithersError, never>;
type SignalRunOptions = SignalRunOptions$1;

type WatchTreeOptions$2 = {
    /** Patterns to ignore (directory basenames) */
    ignore?: string[];
    /** Debounce interval in ms (default: 100) */
    debounceMs?: number;
};

type OverlayOptions$2 = {
    /** Directory basenames to exclude from overlay */
    exclude?: string[];
};

type HotReloadEvent$2 = {
    type: "reloaded";
    generation: number;
    changedFiles: string[];
    newBuild: SmithersWorkflow$2<unknown>["build"];
} | {
    type: "failed";
    generation: number;
    changedFiles: string[];
    error: unknown;
} | {
    type: "unsafe";
    generation: number;
    changedFiles: string[];
    reason: string;
};

declare class WatchTree {
    /**
   * @param {string} rootDir
   * @param {WatchTreeOptions} [opts]
   */
    constructor(rootDir: string, opts?: WatchTreeOptions$1);
    watchers: any[];
    rootDir: string;
    ignore: string[];
    debounceMs: number;
    changedFiles: Set<any>;
    debounceTimer: null;
    waitResolve: null;
    closed: boolean;
    /** Start watching. Call once. */
    start(): Promise<void>;
    /**
     * Returns a promise that resolves with changed file paths
     * the next time file changes are detected (after debounce).
     * Can be called repeatedly.
     */
    wait(): Promise<any>;
    /** Stop all watchers and clean up. */
    close(): void;
    startEffect(): Effect.Effect<void, _smithers_errors_toSmithersError.SmithersError, never>;
    waitEffect(): Effect.Effect<any, never, never>;
    /**
   * @param {string} name
   * @returns {boolean}
   */
    shouldIgnore(name: string): boolean;
    /**
   * @param {string} dir
   * @returns {Promise<void>}
   */
    watchDir(dir: string): Promise<void>;
    /**
   * @param {string} filePath
   */
    onFileChange(filePath: string): void;
    flush(): void;
}
type WatchTreeOptions$1 = WatchTreeOptions$2;

declare class HotWorkflowController {
    /**
   * @param {string} entryPath
   * @param {HotReloadOptions} [opts]
   */
    constructor(entryPath: string, opts?: HotReloadOptions);
    entryPath: string;
    hotRoot: string;
    outDir: string;
    maxGenerations: number;
    watcher: WatchTree;
    generation: number;
    closed: boolean;
    /** Initialize: start file watchers. Call once before using wait/reload. */
    init(): Promise<void>;
    /** Current generation number. */
    get gen(): number;
    /**
     * Wait for the next file change event.
     * Returns the list of changed file paths.
     * Use this in Promise.race with inflight tasks to wake the engine loop.
     */
    wait(): Promise<any>;
    /**
     * Perform a hot reload:
     * 1. Build a new generation overlay
     * 2. Import the workflow module from the overlay
     * 3. Validate the module
     * 4. Return the result (reloaded, failed, or unsafe)
     *
     * The caller is responsible for swapping workflow.build on success.
     *
     * @param {string[]} changedFiles
     * @returns {Promise<HotReloadEvent>}
     */
    reload(changedFiles: string[]): Promise<HotReloadEvent$1>;
    initEffect(): Effect.Effect<void, SmithersError, never>;
    waitEffect(): Effect.Effect<any, never, never>;
    /**
   * @param {string[]} changedFiles
   */
    reloadEffect(changedFiles: string[]): Effect.Effect<{
        type: string;
        generation: number;
        changedFiles: string[];
        error: SmithersError;
        newBuild?: undefined;
    } | {
        type: string;
        generation: number;
        changedFiles: string[];
        newBuild: any;
        error?: undefined;
    } | {
        type: string;
        generation: number;
        changedFiles: string[];
        reason: string;
        error?: undefined;
    } | {
        type: string;
        generation: number;
        changedFiles: string[];
        error: SmithersError;
        reason?: undefined;
    }, never, never>;
    /** Stop watchers and clean up overlay directory. */
    close(): Promise<void>;
    closeEffect(): Effect.Effect<any, any, any>;
}
type HotReloadEvent$1 = HotReloadEvent$2;
type HotReloadOptions = _smithers_driver_RunOptions.HotReloadOptions;

/**
 * @param {string} hotRoot
 * @param {string} outDir
 * @param {number} generation
 * @param {OverlayOptions} [opts]
 * @returns {Promise<string>}
 */
declare function buildOverlay(hotRoot: string, outDir: string, generation: number, opts?: OverlayOptions$1): Promise<string>;
/**
 * @param {string} outDir
 * @param {number} keepLast
 * @returns {Promise<void>}
 */
declare function cleanupGenerations(outDir: string, keepLast: number): Promise<void>;
/**
 * Resolve the overlay entry path given the original entry path,
 * the hot root, and the overlay generation directory.
 *
 * @param {string} entryPath
 * @param {string} hotRoot
 * @param {string} genDir
 * @returns {string}
 */
declare function resolveOverlayEntry(entryPath: string, hotRoot: string, genDir: string): string;
type OverlayOptions$1 = OverlayOptions$2;

type HotReloadEvent = HotReloadEvent$2;
type OverlayOptions = OverlayOptions$2;
type WatchTreeOptions = WatchTreeOptions$2;

type TaskActivityContext$1 = {
    attempt: number;
    idempotencyKey: string;
};

type TaskBridgeToolConfig$1 = {
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
};

type HijackCompletion = {
    requestedAtMs: number;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    mode: "native-cli" | "conversation";
    resume?: string;
    messages?: unknown[];
    cwd: string;
};
type HijackState$1 = {
    request: {
        requestedAtMs: number;
        target?: string | null;
    } | null;
    completion: HijackCompletion | null;
};

type LegacyExecuteTaskFn$1 = (adapter: SmithersDb, db: BunSQLiteDatabase$3<Record<string, unknown>>, runId: string, desc: TaskDescriptor, descriptorMap: Map<string, TaskDescriptor>, inputTable: SQLiteTable$1, eventBus: EventBus, toolConfig: TaskBridgeToolConfig$1, workflowName: string, cacheEnabled: boolean, signal?: AbortSignal, disabledAgents?: Set<string>, runAbortController?: AbortController, hijackState?: HijackState$1) => Promise<void>;

declare function makeDurableDeferredBridgeExecutionId(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number): string;
declare function makeApprovalDurableDeferred(nodeId: string): any;
declare function makeWaitForEventDurableDeferred(nodeId: string): any;
declare function awaitApprovalDurableDeferred(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number): Promise<BridgeDeferredResult>;
declare function awaitWaitForEventDurableDeferred(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number): Promise<BridgeDeferredResult>;
declare function bridgeApprovalResolve(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number, resolution: {
    approved: boolean;
    note?: string | null;
    decidedBy?: string | null;
    decisionJson?: string | null;
    autoApproved?: boolean;
}): Promise<void>;
declare function bridgeWaitForEventResolve(adapter: _SmithersDb$4, runId: string, nodeId: string, iteration: number, signal: WaitForEventSignalInput): Promise<void>;
declare function bridgeSignalResolve(adapter: _SmithersDb$4, runId: string, signal: WaitForEventSignalInput): Promise<void>;
type BridgeDeferredResult = {
    _tag: "Complete";
    exit: Exit.Exit<any, any>;
} | {
    _tag: "Pending";
};
type _SmithersDb$4 = _smithers_db_adapter.SmithersDb;
type WaitForEventSignalInput = {
    signalName: string;
    correlationId: string | null;
    payloadJson: string;
    seq: number;
    receivedAtMs: number;
};

/**
 * @param {_TaskDescriptor} desc
 * @returns {boolean}
 */
declare function isBridgeManagedTimerTask(desc: _TaskDescriptor$5): boolean;
/**
 * @param {_TaskDescriptor} desc
 * @returns {boolean}
 */
declare function isBridgeManagedWaitForEventTask(desc: _TaskDescriptor$5): boolean;
/**
 * @param {_SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {EventBus} eventBus
 * @param {DeferredBridgeStateEmitter} [emitStateEvent]
 * @returns {Promise<DeferredBridgeResolution>}
 */
declare function resolveDeferredTaskStateBridge(adapter: _SmithersDb$3, db: BunSQLiteDatabase$2, runId: string, desc: _TaskDescriptor$5, eventBus: EventBus, emitStateEvent?: DeferredBridgeStateEmitter): Promise<DeferredBridgeResolution>;
/**
 * @param {_SmithersDb} adapter
 * @param {string} runId
 * @param {EventBus} eventBus
 * @param {string} reason
 */
declare function cancelPendingTimersBridge(adapter: _SmithersDb$3, runId: string, eventBus: EventBus, reason: string): Promise<void>;
type DeferredBridgeState = "pending" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "failed" | "skipped";
type DeferredBridgeResolution = {
    handled: false;
} | {
    handled: true;
    state: DeferredBridgeState;
};
type DeferredBridgeStateEmitter = (state: "pending" | "failed" | "skipped") => Promise<void>;
type _SmithersDb$3 = _smithers_db_adapter.SmithersDb;
type _TaskDescriptor$5 = _smithers_graph_TaskDescriptor.TaskDescriptor;
type BunSQLiteDatabase$2 = drizzle_orm_bun_sqlite.BunSQLiteDatabase<Record<string, unknown>>;

/**
 * @template T
 * @param {WorkflowMakeBridgeRuntime} runtime
 * @param {() => T} execute
 * @returns {T}
 */
declare function withWorkflowMakeBridgeRuntime<T>(runtime: WorkflowMakeBridgeRuntime, execute: () => T): T;
/**
 * @returns {| WorkflowMakeBridgeRuntime | undefined}
 */
declare function getWorkflowMakeBridgeRuntime(): WorkflowMakeBridgeRuntime | undefined;
/**
 * @returns {SchedulerWakeQueue}
 */
declare function createSchedulerWakeQueue(): SchedulerWakeQueue;
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions & { runId: string }} opts
 * @param {RunBodyExecutor} executeBody
 * @returns {Promise<RunResult>}
 */
declare function runWorkflowWithMakeBridge<Schema>(workflow: SmithersWorkflow$1<Schema>, opts: RunOptions$1 & {
    runId: string;
}, executeBody: RunBodyExecutor): Promise<RunResult$1>;
type RunBodyResult = RunResult$1 | (RunResult$1 & {
    status: "continued";
    nextRunId: string;
});
type RunBodyExecutor = <Schema>(workflow: SmithersWorkflow$1<Schema>, opts: RunOptions$1) => Promise<RunBodyResult>;
type RunOptions$1 = _smithers_driver_RunOptions.RunOptions;
type RunResult$1 = _smithers_driver_RunResult.RunResult;
type SchedulerWakeQueue = {
    notify(): void;
    wait(): Promise<void>;
};
type SmithersWorkflow$1 = any;
type WorkflowEngineContext = effect.Context.Context<WorkflowEngine.WorkflowEngine>;
type WorkflowMakeBridgeRuntime = {
    readonly engineContext: WorkflowEngineContext;
    readonly scope: Scope.CloseableScope;
    readonly parentInstance: WorkflowEngine.WorkflowInstance["Type"];
    readonly executeBody: RunBodyExecutor;
    executeChildWorkflow: <Schema>(workflow: SmithersWorkflow$1<Schema>, opts: RunOptions$1 & {
        runId: string;
    }) => Promise<RunResult$1>;
};

type SqlMessageStorageEventHistoryQuery$1 = {
    afterSeq?: number;
    limit?: number;
    nodeId?: string;
    types?: readonly string[];
    sinceTimestampMs?: number;
};

/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {SqlMessageStorage}
 */
declare function getSqlMessageStorage(db: BunSQLiteDatabase$1<any> | Database): SqlMessageStorage;
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Effect.Effect<void, never>}
 */
declare function ensureSqlMessageStorageEffect(db: BunSQLiteDatabase$1<any> | Database): Effect.Effect<void, never>;
/**
 * @param {BunSQLiteDatabase<any> | Database} db
 * @returns {Promise<void>}
 */
declare function ensureSqlMessageStorage(db: BunSQLiteDatabase$1<any> | Database): Promise<void>;
declare class SqlMessageStorage {
    /**
   * @param {BunSQLiteDatabase<any> | Database} db
   */
    constructor(db: BunSQLiteDatabase$1<any> | Database);
    sqlite: Database;
    runtime: ManagedRuntime.ManagedRuntime<any, never>;
    tableColumnsCache: Map<any, any>;
    /**
   * @param {string} table
   * @returns {Set<string>}
   */
    getTableColumns(table: string): Set<string>;
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Record<string, unknown>}
   */
    filterKnownColumns(table: string, row: Record<string, unknown>): Record<string, unknown>;
    /**
   * @template A, E
   * @param {Effect.Effect<A, E, SqlClient.SqlClient>} effect
   * @returns {Promise<A>}
   */
    runEffect<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A>;
    /**
   * @template A
   * @param {(connection: Connection) => Effect.Effect<A, SqlError>} f
   * @returns {Promise<A>}
   */
    withConnection<A>(f: (connection: Connection) => Effect.Effect<A, SqlError>): Promise<A>;
    /**
   * @returns {Effect.Effect<void, never>}
   */
    ensureSchemaEffect(): Effect.Effect<void, never>;
    /**
   * @returns {Promise<void>}
   */
    ensureSchema(): Promise<void>;
    /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @param {{ booleanColumns?: readonly string[] }} [options]
   * @returns {Promise<Array<T>>}
   */
    queryAll<T>(statement: string, params?: ReadonlyArray<SqliteParam>, options?: {
        booleanColumns?: readonly string[];
    }): Promise<Array<T>>;
    /**
   * @template T
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @param {{ booleanColumns?: readonly string[] }} [options]
   * @returns {Promise<T | undefined>}
   */
    queryOne<T>(statement: string, params?: ReadonlyArray<SqliteParam>, options?: {
        booleanColumns?: readonly string[];
    }): Promise<T | undefined>;
    /**
   * @param {string} statement
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    execute(statement: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @returns {Promise<void>}
   */
    insertIgnore(table: string, row: Record<string, unknown>): Promise<void>;
    /**
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @param {readonly string[]} conflictColumns
   * @param {readonly string[]} [updateColumns]
   * @returns {Promise<void>}
   */
    upsert(table: string, row: Record<string, unknown>, conflictColumns: readonly string[], updateColumns?: readonly string[]): Promise<void>;
    /**
   * @param {string} table
   * @param {Record<string, unknown>} patch
   * @param {string} whereSql
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    updateWhere(table: string, patch: Record<string, unknown>, whereSql: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    /**
   * @param {string} table
   * @param {string} whereSql
   * @param {ReadonlyArray<SqliteParam>} [params]
   * @returns {Promise<void>}
   */
    deleteWhere(table: string, whereSql: string, params?: ReadonlyArray<SqliteParam>): Promise<void>;
    /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {{ whereSql: string; params: Array<SqliteParam> }}
   */
    buildEventHistoryWhere(runId: string, query?: SqlMessageStorageEventHistoryQuery): {
        whereSql: string;
        params: Array<SqliteParam>;
    };
    /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
    listEventHistory(runId: string, query?: SqlMessageStorageEventHistoryQuery): Promise<Array<Record<string, unknown>>>;
    /**
   * @param {string} runId
   * @param {SqlMessageStorageEventHistoryQuery} [query]
   * @returns {Promise<number>}
   */
    countEventHistory(runId: string, query?: SqlMessageStorageEventHistoryQuery): Promise<number>;
    /**
   * @param {string} runId
   * @returns {Promise<number | undefined>}
   */
    getLastEventSeq(runId: string): Promise<number | undefined>;
    /**
   * @param {string} runId
   * @param {string} type
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
    listEventsByType(runId: string, type: string): Promise<Array<Record<string, unknown>>>;
    /**
   * @param {string} runId
   * @returns {Promise<number | undefined>}
   */
    getLastSignalSeq(runId: string): Promise<number | undefined>;
}
type BunSQLiteDatabase$1 = drizzle_orm_bun_sqlite.BunSQLiteDatabase;
type SqlMessageStorageEventHistoryQuery = SqlMessageStorageEventHistoryQuery$1;
type SqliteParam = string | number | bigint | boolean | Uint8Array | null | undefined;

declare const DockerSandboxExecutorLive: Layer.Layer<any, never, never>;
declare const CodeplaneSandboxExecutorLive: Layer.Layer<any, never, never>;
declare const SandboxHttpRunner: any;

type UnknownWorkerError = {
    _tag: "UnknownWorkerError";
    errorId: string;
    message: string;
};

type TaggedWorkerError = {
    _tag: "TaskAborted";
    message: string;
    details?: Record<string, unknown>;
    name?: string;
} | {
    _tag: "TaskTimeout";
    message: string;
    nodeId: string;
    attempt: number;
    timeoutMs: number;
} | {
    _tag: "TaskHeartbeatTimeout";
    message: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    timeoutMs: number;
    staleForMs: number;
    lastHeartbeatAtMs: number;
} | {
    _tag: "RunNotFound";
    message: string;
    runId: string;
} | {
    _tag: "InvalidInput";
    message: string;
    details?: Record<string, unknown>;
} | {
    _tag: "DbWriteFailed";
    message: string;
    details?: Record<string, unknown>;
} | {
    _tag: "AgentCliError";
    message: string;
    details?: Record<string, unknown>;
} | {
    _tag: "WorkflowFailed";
    message: string;
    details?: Record<string, unknown>;
    status?: number;
};

type WorkerTaskError = TaggedWorkerError | UnknownWorkerError;

type TaskResult$1 = {
    _tag: "Success";
    executionId: string;
    terminal: boolean;
} | {
    _tag: "Failure";
    executionId: string;
    error: WorkerTaskError;
};

type TaskFailure$1 = Extract<TaskResult$1, {
    _tag: "Failure";
}>;

type WorkerTaskKind$1 = "agent" | "compute" | "static";

type WorkerDispatchKind$1 = "compute" | "static" | "legacy";

type WorkerTask$2 = {
    executionId: string;
    bridgeKey: string;
    workflowName: string;
    runId: string;
    nodeId: string;
    iteration: number;
    retries: number;
    taskKind: WorkerTaskKind$1;
    dispatchKind: WorkerDispatchKind$1;
};

/**
 * @param {string} bridgeKey
 * @param {string} workflowName
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {WorkerDispatchKind} dispatchKind
 * @returns {WorkerTask}
 */
declare function makeWorkerTask(bridgeKey: string, workflowName: string, runId: string, desc: _TaskDescriptor$4, dispatchKind: WorkerDispatchKind): WorkerTask$1;
/**
 * @param {TaskResult} result
 * @returns {result is TaskFailure}
 */
declare function isTaskResultFailure(result: TaskResult): result is TaskFailure;
type WorkerTaskKind = WorkerTaskKind$1;
/** @typedef {import("@smithers/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */
declare const WorkerTaskKind: Schema.Literal<["agent", "compute", "static"]>;
type WorkerDispatchKind = WorkerDispatchKind$1;
declare const WorkerDispatchKind: Schema.Literal<["compute", "static", "legacy"]>;
type WorkerTask$1 = WorkerTask$2;
declare const WorkerTask$1: Schema.Struct<{
    executionId: typeof Schema.String;
    bridgeKey: typeof Schema.String;
    workflowName: typeof Schema.String;
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    retries: typeof Schema.Number;
    taskKind: Schema.Literal<["agent", "compute", "static"]>;
    dispatchKind: Schema.Literal<["compute", "static", "legacy"]>;
}>;
type TaskResult = TaskResult$1;
declare const TaskResult: Schema.Union<[Schema.Struct<{
    _tag: Schema.Literal<["Success"]>;
    executionId: typeof Schema.String;
    terminal: typeof Schema.Boolean;
}>, Schema.Struct<{
    _tag: Schema.Literal<["Failure"]>;
    executionId: typeof Schema.String;
    error: Schema.Union<[Schema.Union<[Schema.Struct<{
        _tag: Schema.Literal<["TaskAborted"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        name: Schema.optional<typeof Schema.String>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["TaskHeartbeatTimeout"]>;
        message: typeof Schema.String;
        nodeId: typeof Schema.String;
        iteration: typeof Schema.Number;
        attempt: typeof Schema.Number;
        timeoutMs: typeof Schema.Number;
        staleForMs: typeof Schema.Number;
        lastHeartbeatAtMs: typeof Schema.Number;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["RunNotFound"]>;
        message: typeof Schema.String;
        runId: typeof Schema.String;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["InvalidInput"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["DbWriteFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["AgentCliError"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
    }>, Schema.Struct<{
        _tag: Schema.Literal<["WorkflowFailed"]>;
        message: typeof Schema.String;
        details: Schema.optional<Schema.Record$<typeof Schema.String, typeof Schema.Unknown>>;
        status: Schema.optional<typeof Schema.Number>;
    }>]>, Schema.Struct<{
        _tag: Schema.Literal<["UnknownWorkerError"]>;
        errorId: typeof Schema.String;
        message: typeof Schema.String;
    }>]>;
}>]>;
declare const TaskWorkerEntity: any;
type TaskFailure = TaskFailure$1;
type _TaskDescriptor$4 = _smithers_graph_TaskDescriptor.TaskDescriptor;

/**
 * @param {WorkerTask} task
 * @param {() => Promise<WorkerExecutionResult>} execute
 * @returns {Promise<WorkerExecutionResult>}
 */
declare function dispatchWorkerTask(task: WorkerTask, execute: () => Promise<WorkerExecutionResult>): Promise<WorkerExecutionResult>;
/**
 * @param {TaskWorkerDispatchSubscriber} subscriber
 * @returns {() => void}
 */
declare function subscribeTaskWorkerDispatches(subscriber: TaskWorkerDispatchSubscriber): () => void;
type TaskWorkerDispatchSubscriber = (task: WorkerTask) => void;
type WorkerExecutionResult = {
    terminal: boolean;
};
type WorkerTask = WorkerTask$2;

declare function executeTaskBridge(adapter: SmithersDb, db: _BunSQLiteDatabase$1, runId: string, desc: _TaskDescriptor$3, descriptorMap: Map<string, _TaskDescriptor$3>, inputTable: SQLiteTable, eventBus: EventBus, toolConfig: TaskBridgeToolConfig, workflowName: string, cacheEnabled: boolean, signal?: AbortSignal, disabledAgents?: Set<string>, runAbortController?: AbortController, hijackState?: HijackState, legacyExecuteTaskFn?: LegacyExecuteTaskFn): Promise<void>;
declare function executeTaskBridgeEffect(adapter: SmithersDb, db: _BunSQLiteDatabase$1, runId: string, desc: _TaskDescriptor$3, descriptorMap: Map<string, _TaskDescriptor$3>, inputTable: SQLiteTable, eventBus: EventBus, toolConfig: TaskBridgeToolConfig, workflowName: string, cacheEnabled: boolean, signal?: AbortSignal, disabledAgents?: Set<string>, runAbortController?: AbortController, hijackState?: HijackState, legacyExecuteTaskFn?: LegacyExecuteTaskFn): Effect.Effect<void, _smithers_errors_SmithersError.SmithersError, never>;
type HijackState = HijackState$1;
type LegacyExecuteTaskFn = LegacyExecuteTaskFn$1;
type TaskBridgeToolConfig = TaskBridgeToolConfig$1;
type _TaskDescriptor$3 = _smithers_graph_TaskDescriptor.TaskDescriptor;
type _TaskActivityContext = TaskActivityContext$1;
type _BunSQLiteDatabase$1 = drizzle_orm_bun_sqlite.BunSQLiteDatabase<Record<string, unknown>>;
type SQLiteTable = drizzle_orm_sqlite_core.SQLiteTable;
type BridgeManagedTaskKind = "compute" | "static" | "legacy";

type TaskActivityRetryOptions$1 = {
    times: number;
    while?: (error: unknown) => boolean;
};

type ExecuteTaskActivityOptions$1 = {
    initialAttempt?: number;
    retry?: false | TaskActivityRetryOptions$1;
    includeAttemptInIdempotencyKey?: boolean;
};

declare class RetriableTaskFailure extends Error {
    /**
   * @param {string} nodeId
   * @param {number} attempt
   */
    constructor(nodeId: string, attempt: number);
    nodeId: string;
    attempt: number;
}
declare function makeTaskBridgeKey(adapter: _SmithersDb$2, workflowName: string, runId: string, desc: _TaskDescriptor$2): string;
declare function makeTaskActivity<A>(desc: _TaskDescriptor$2, executeFn: (context: TaskActivityContext) => Promise<A> | A, options?: Pick<ExecuteTaskActivityOptions, "includeAttemptInIdempotencyKey">): any;
declare function executeTaskActivity<A>(adapter: _SmithersDb$2, workflowName: string, runId: string, desc: _TaskDescriptor$2, executeFn: (context: TaskActivityContext) => Promise<A> | A, options?: ExecuteTaskActivityOptions): Promise<A>;
type TaskActivityRetryOptions = TaskActivityRetryOptions$1;
type ExecuteTaskActivityOptions = ExecuteTaskActivityOptions$1;
type TaskActivityContext = TaskActivityContext$1;
type _SmithersDb$2 = _smithers_db_adapter.SmithersDb;
type _TaskDescriptor$2 = _smithers_graph_TaskDescriptor.TaskDescriptor;

/**
 * @returns {TaskAborted}
 */
declare function makeAbortError(message?: string): TaskAborted;
/**
 * @param {AbortController} controller
 * @param {AbortSignal} [signal]
 */
declare function wireAbortSignal(controller: AbortController, signal?: AbortSignal): () => void;
/**
 * @param {string | null} [metaJson]
 * @returns {Record<string, unknown>}
 */
declare function parseAttemptMetaJson(metaJson?: string | null): Record<string, unknown>;

type SmithersSqliteOptions$1 = {
    filename: string;
};

type AnySchema$1 = Schema.Schema<unknown, unknown, never>;
type AnyEffect = unknown | Promise<unknown> | Effect.Effect<unknown, unknown, unknown>;
type BuilderStepContext$1 = Record<string, unknown> & {
    input: unknown;
    executionId: string;
    stepId: string;
    attempt: number;
    signal: AbortSignal;
    iteration: number;
    heartbeat: (data?: unknown) => void;
    lastHeartbeat: unknown | null;
};
type ApprovalOptions$1 = {
    needs?: Record<string, BuilderStepHandle$1>;
    request: (ctx: Record<string, unknown>) => {
        title: string;
        summary?: string | null;
    };
    onDeny?: "fail" | "continue" | "skip";
};
type BuilderStepHandle$1 = {
    kind: "step" | "approval";
    id: string;
    localId: string;
    tableKey: string;
    tableName: string;
    table: SQLiteTable$1;
    output: AnySchema$1;
    needs: Record<string, BuilderStepHandle$1>;
    run?: (ctx: BuilderStepContext$1) => AnyEffect;
    request?: ApprovalOptions$1["request"];
    onDeny?: "fail" | "continue" | "skip";
    retries: number;
    retryPolicy?: RetryPolicy$1;
    timeoutMs: number | null;
    skipIf?: (ctx: BuilderStepContext$1) => boolean;
    loopId?: string;
    cache?: CachePolicy;
};

type SequenceNode = {
    kind: "sequence";
    children: BuilderNode$1[];
};
type ParallelNode = {
    kind: "parallel";
    children: BuilderNode$1[];
    maxConcurrency?: number;
};
type LoopNode = {
    kind: "loop";
    id?: string;
    children: BuilderNode$1;
    until: (outputs: Record<string, unknown>) => boolean;
    maxIterations?: number;
    onMaxReached?: "fail" | "return-last";
    handles?: BuilderStepHandle$1[];
};
type MatchNode = {
    kind: "match";
    source: BuilderStepHandle$1;
    when: (value: unknown) => boolean;
    then: BuilderNode$1;
    else?: BuilderNode$1;
};
type BranchNode = {
    kind: "branch";
    condition: (ctx: Record<string, unknown>) => boolean;
    needs?: Record<string, BuilderStepHandle$1>;
    then: BuilderNode$1;
    else?: BuilderNode$1;
};
type WorktreeNode = {
    kind: "worktree";
    id?: string;
    path: string;
    branch?: string;
    skipIf?: (ctx: Record<string, unknown>) => boolean;
    needs?: Record<string, BuilderStepHandle$1>;
    children: BuilderNode$1;
};
type BuilderNode$1 = BuilderStepHandle$1 | SequenceNode | ParallelNode | LoopNode | MatchNode | BranchNode | WorktreeNode;

/** @type {{ sqlite: typeof sqlite }} */
declare const Smithers: {
    sqlite: typeof sqlite;
};
type AnySchema = effect.Schema.Schema<unknown, unknown, never>;
type ApprovalOptions = {
    needs?: Record<string, BuilderStepHandle>;
    request: (ctx: Record<string, unknown>) => {
        title: string;
        summary?: string | null;
    };
    onDeny?: "fail" | "continue" | "skip";
};
type BuilderNode = BuilderNode$1;
type BuilderStepContext = Record<string, unknown> & {
    input: unknown;
    executionId: string;
    stepId: string;
    attempt: number;
    signal: AbortSignal;
    iteration: number;
    heartbeat: (data?: unknown) => void;
    lastHeartbeat: unknown | null;
};
type BuilderStepHandle = BuilderStepHandle$1;
type RetryPolicy = _smithers_scheduler_RetryPolicy.RetryPolicy;
type SmithersSqliteOptions = SmithersSqliteOptions$1;
/**
 * @param {SmithersSqliteOptions} options
 */
declare function sqlite(options: SmithersSqliteOptions): Layer.Layer<any, never, never>;

declare function canExecuteBridgeManagedComputeTask(desc: _TaskDescriptor$1, cacheEnabled: boolean): boolean;
declare function executeComputeTaskBridge(adapter: _SmithersDb$1, db: _BunSQLiteDatabase, runId: string, desc: _TaskDescriptor$1, eventBus: EventBus, toolConfig: ComputeTaskBridgeToolConfig, workflowName: string, signal?: AbortSignal): Promise<void>;
type ComputeTaskBridgeToolConfig = {
    rootDir: string;
};
type _SmithersDb$1 = _smithers_db_adapter.SmithersDb;
type _TaskDescriptor$1 = _smithers_graph_TaskDescriptor.TaskDescriptor;
type _BunSQLiteDatabase = drizzle_orm_bun_sqlite.BunSQLiteDatabase<Record<string, unknown>>;

type FilePatch$1 = {
    path: string;
    operation: "add" | "modify" | "delete";
    diff: string;
    binaryContent?: string;
};

type DiffBundle$1 = {
    seq: number;
    baseRef: string;
    patches: FilePatch$1[];
};

/**
 * Compute a diff bundle strictly between two immutable refs.
 *
 * Unlike {@link computeDiffBundle}, this variant does NOT read the working
 * tree or untracked files. It is the preferred entry point for historical
 * diffs (e.g. the `getNodeDiff` RPC) because it is read-only and cannot be
 * contaminated by concurrent runs mutating the checkout.
 *
 * @param {string} baseRef
 * @param {string} targetRef
 * @param {string} currentDir
 * @param {number} [seq]
 * @returns {Promise<DiffBundle>}
 */
declare function computeDiffBundleBetweenRefs(baseRef: string, targetRef: string, currentDir: string, seq?: number): Promise<DiffBundle>;
/**
 * @param {string} baseRef
 * @param {string} currentDir
 * @returns {Promise<DiffBundle>}
 */
declare function computeDiffBundle(baseRef: string, currentDir: string, seq?: number): Promise<DiffBundle>;
/**
 * @param {DiffBundle} bundle
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
declare function applyDiffBundle(bundle: DiffBundle, targetDir: string): Promise<void>;
type DiffBundle = DiffBundle$1;
type FilePatch = FilePatch$1;

type SignalResult$1 = {
    runId: string;
    signalName: string;
    delivered: boolean;
    status: "signalled" | "ignored";
};

type SignalPayload$1 = {
    runId: string;
    signalName: string;
    data?: unknown;
    correlationId?: string;
    sentBy?: string;
};

type RunStatusSchema$1 = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "continued" | "failed" | "cancelled";

type RunSummary$1 = {
    runId: string;
    parentRunId: string | null;
    workflowName: string;
    workflowPath: string | null;
    workflowHash: string | null;
    status: RunStatusSchema$1;
    createdAtMs: number;
    startedAtMs: number | null;
    finishedAtMs: number | null;
    heartbeatAtMs: number | null;
    runtimeOwnerId: string | null;
    cancelRequestedAtMs: number | null;
    hijackRequestedAtMs: number | null;
    hijackTarget: string | null;
    vcsType: string | null;
    vcsRoot: string | null;
    vcsRevision: string | null;
    errorJson: string | null;
    configJson: string | null;
};

type ListRunsPayload$1 = {
    limit?: number;
    status?: RunStatusSchema$1;
};

type GetRunResult$1 = RunSummary$1 | null;

type GetRunPayload$1 = {
    runId: string;
};

type CancelResult$1 = {
    runId: string;
    status: "cancelling" | "cancelled";
};

type CancelPayload$1 = {
    runId: string;
};

type ApprovalResult$1 = {
    runId: string;
    nodeId: string;
    iteration: number;
    approved: boolean;
};

type ApprovalPayload$1 = {
    runId: string;
    nodeId: string;
    iteration?: number;
    note?: string;
    decidedBy?: string;
};

type RunStatusSchema = RunStatusSchema$1;
declare const RunStatusSchema: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
declare const ApprovalPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: Schema.optional<typeof Schema.Number>;
    note: Schema.optional<typeof Schema.String>;
    decidedBy: Schema.optional<typeof Schema.String>;
}>;
declare const ApprovalResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    nodeId: typeof Schema.String;
    iteration: typeof Schema.Number;
    approved: typeof Schema.Boolean;
}>;
declare const CancelPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
}>;
declare const CancelResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    status: Schema.Literal<["cancelling", "cancelled"]>;
}>;
declare const SignalPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    data: Schema.optional<typeof Schema.Unknown>;
    correlationId: Schema.optional<typeof Schema.String>;
    sentBy: Schema.optional<typeof Schema.String>;
}>;
declare const SignalResultSchema: Schema.Struct<{
    runId: typeof Schema.String;
    signalName: typeof Schema.String;
    delivered: typeof Schema.Boolean;
    status: Schema.Literal<["signalled", "ignored"]>;
}>;
declare const ListRunsPayloadSchema: Schema.Struct<{
    limit: Schema.optional<typeof Schema.Number>;
    status: Schema.optional<Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>>;
}>;
declare const RunSummarySchema: Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>;
declare const GetRunPayloadSchema: Schema.Struct<{
    runId: typeof Schema.String;
}>;
declare const GetRunResultSchema: Schema.NullOr<Schema.Struct<{
    runId: typeof Schema.String;
    parentRunId: Schema.NullOr<typeof Schema.String>;
    workflowName: typeof Schema.String;
    workflowPath: Schema.NullOr<typeof Schema.String>;
    workflowHash: Schema.NullOr<typeof Schema.String>;
    status: Schema.Literal<["running", "waiting-approval", "waiting-event", "waiting-timer", "finished", "continued", "failed", "cancelled"]>;
    createdAtMs: typeof Schema.Number;
    startedAtMs: Schema.NullOr<typeof Schema.Number>;
    finishedAtMs: Schema.NullOr<typeof Schema.Number>;
    heartbeatAtMs: Schema.NullOr<typeof Schema.Number>;
    runtimeOwnerId: Schema.NullOr<typeof Schema.String>;
    cancelRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackRequestedAtMs: Schema.NullOr<typeof Schema.Number>;
    hijackTarget: Schema.NullOr<typeof Schema.String>;
    vcsType: Schema.NullOr<typeof Schema.String>;
    vcsRoot: Schema.NullOr<typeof Schema.String>;
    vcsRevision: Schema.NullOr<typeof Schema.String>;
    errorJson: Schema.NullOr<typeof Schema.String>;
    configJson: Schema.NullOr<typeof Schema.String>;
}>>;
declare const approve: any;
declare const cancel: any;
declare const signal: any;
declare const listRuns: any;
declare const getRun: any;
declare const SmithersRpcGroup: any;
type ApprovalPayload = ApprovalPayload$1;
type ApprovalResult = ApprovalResult$1;
type CancelPayload = CancelPayload$1;
type CancelResult = CancelResult$1;
type GetRunPayload = GetRunPayload$1;
type GetRunResult = GetRunResult$1;
type ListRunsPayload = ListRunsPayload$1;
type RunSummary = RunSummary$1;
type SignalPayload = SignalPayload$1;
type SignalResult = SignalResult$1;

declare function canExecuteBridgeManagedStaticTask(desc: _TaskDescriptor, cacheEnabled: boolean): boolean;
declare function executeStaticTaskBridge(adapter: _SmithersDb, runId: string, desc: _TaskDescriptor, eventBus: EventBus, toolConfig: StaticTaskBridgeToolConfig, workflowName: string, signal?: AbortSignal): Promise<void>;
type _SmithersDb = _smithers_db_adapter.SmithersDb;
type StaticTaskBridgeToolConfig = {
    rootDir: string;
};
type _TaskDescriptor = _smithers_graph_TaskDescriptor.TaskDescriptor;

type WorkflowPatchDecisions$1 = Record<string, boolean>;

type WorkflowVersioningRuntime$1 = {
    resolve(patchId: string): boolean;
    flush(): Promise<void>;
    snapshot(): WorkflowPatchDecisions$1;
};

type WorkflowPatchDecisionRecord$1 = {
    patchId: string;
    decision: boolean;
};

/**
 * @param {WorkflowVersioningRuntimeOptions} options
 * @returns {WorkflowVersioningRuntime}
 */
declare function createWorkflowVersioningRuntime(options: WorkflowVersioningRuntimeOptions): WorkflowVersioningRuntime;
/**
 * @template T
 * @param {WorkflowVersioningRuntime} runtime
 * @param {() => T} execute
 * @returns {T}
 */
declare function withWorkflowVersioningRuntime<T>(runtime: WorkflowVersioningRuntime, execute: () => T): T;
/**
 * @returns {| WorkflowVersioningRuntime | undefined}
 */
declare function getWorkflowVersioningRuntime(): WorkflowVersioningRuntime | undefined;
/**
 * @param {Record<string, unknown> | null | undefined} config
 * @returns {WorkflowPatchDecisions}
 */
declare function getWorkflowPatchDecisions(config: Record<string, unknown> | null | undefined): WorkflowPatchDecisions;
/**
 * @param {string} patchId
 * @returns {boolean}
 */
declare function usePatched(patchId: string): boolean;
type WorkflowPatchDecisionRecord = WorkflowPatchDecisionRecord$1;
type WorkflowPatchDecisions = WorkflowPatchDecisions$1;
type WorkflowVersioningRuntime = WorkflowVersioningRuntime$1;
type WorkflowVersioningRuntimeOptions = {
    baseConfig: Record<string, unknown>;
    initialDecisions?: WorkflowPatchDecisions;
    isNewRun: boolean;
    persist: (config: Record<string, unknown>) => Promise<void>;
    recordDecision?: (record: WorkflowPatchDecisionRecord) => Promise<void>;
};

/**
 * @typedef {Record<string, any>} JsonSchema
 */
/**
 * Convert a JSON Schema to a Zod object schema.
 *
 * @param {JsonSchema} rootSchema
 * @returns {z.ZodObject<any>}
 */
declare function jsonSchemaToZod(rootSchema: JsonSchema): z.ZodObject<any>;
type JsonSchema = Record<string, any>;

/**
 * @param {{ status?: string | null; heartbeatAtMs?: number | null } | null | undefined} run
 * @returns {boolean}
 */
declare function isRunHeartbeatFresh(run: {
    status?: string | null;
    heartbeatAtMs?: number | null;
} | null | undefined, now?: number): boolean;
/**
 * @param {{ _?: { fullSchema?: Record<string, unknown>; schema?: Record<string, unknown> }; schema?: Record<string, unknown> }} db
 * @returns {Record<string, unknown>}
 */
declare function resolveSchema(db: {
    _?: {
        fullSchema?: Record<string, unknown>;
        schema?: Record<string, unknown>;
    };
    schema?: Record<string, unknown>;
}): Record<string, unknown>;
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {SmithersCtx<unknown>} ctx
 * @param {{ baseRootDir?: string; workflowPath?: string | null }} [opts]
 * @returns {Effect.Effect<GraphSnapshot, SmithersError>}
 */
declare function renderFrame<Schema>(workflow: SmithersWorkflow<Schema>, ctx: SmithersCtx<unknown>, opts?: {
    baseRootDir?: string;
    workflowPath?: string | null;
}): Effect.Effect<GraphSnapshot, SmithersError>;
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Effect.Effect<RunResult, SmithersError>}
 */
declare function runWorkflow<Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions): Effect.Effect<RunResult, SmithersError>;
type GraphSnapshot = _smithers_graph_GraphSnapshot.GraphSnapshot;
type RunOptions = _smithers_driver_RunOptions.RunOptions;
type RunResult = _smithers_driver_RunResult.RunResult;
type SmithersWorkflow = any;

type ChildWorkflowDefinition = ChildWorkflowDefinition$1;

export { type AlertHumanRequestOptions, AlertRuntime, type AlertRuntimeServices, type AnySchema, type ApprovalOptions, type ApprovalPayload, ApprovalPayloadSchema, type ApprovalResult, ApprovalResultSchema, type BridgeManagedTaskKind, type BuilderNode, type BuilderStepContext, type BuilderStepHandle, type CancelPayload, CancelPayloadSchema, type CancelResult, CancelResultSchema, type ChildWorkflowDefinition, type ChildWorkflowExecuteOptions, CodeplaneSandboxExecutorLive, type ComputeTaskBridgeToolConfig, type ContinuationRequest, type CorrelatedSmithersEvent, type CorrelationContext, type DiffBundle, DockerSandboxExecutorLive, EventBus, type ExecuteTaskActivityOptions, type FilePatch, type GetRunPayload, GetRunPayloadSchema, type GetRunResult, GetRunResultSchema, HUMAN_REQUEST_KINDS, HUMAN_REQUEST_STATUSES, type HijackState, type HotReloadEvent, HotWorkflowController, type HumanRequestKind, type HumanRequestSchemaValidation, type HumanRequestStatus, type JsonSchema, type LegacyExecuteTaskFn, type ListRunsPayload, ListRunsPayloadSchema, type OverlayOptions, type PlanNode, type RalphMeta, type RalphState, type RalphStateMap, type ReadonlyTaskStateMap, RetriableTaskFailure, type RetryPolicy, type RetryWaitMap, type RunResult$2 as RunResult, RunStatusSchema, type RunSummary, RunSummarySchema, type SQLiteTable, SandboxHttpRunner, type ScheduleResult, type ScheduleSnapshot, type SignalPayload, SignalPayloadSchema, type SignalResult, SignalResultSchema, type SignalRunOptions, Smithers, type SmithersAlertPolicy, type SmithersEvent, SmithersRpcGroup, type SmithersSqliteOptions, SqlMessageStorage, type StaticTaskBridgeToolConfig, type TaskActivityContext, type TaskActivityRetryOptions, type TaskBridgeToolConfig, type TaskRecord, TaskResult, type TaskState, type TaskStateMap, TaskWorkerEntity, WatchTree, type WatchTreeOptions, WorkerDispatchKind, WorkerTask$1 as WorkerTask, WorkerTaskKind, type WorkflowPatchDecisionRecord, type WorkflowPatchDecisions, type WorkflowVersioningRuntime, type WorkflowVersioningRuntimeOptions, type XmlNode, type _TaskActivityContext, applyDiffBundle, approve, approveNode, awaitApprovalDurableDeferred, awaitWaitForEventDurableDeferred, bridgeApprovalResolve, bridgeSignalResolve, bridgeWaitForEventResolve, buildHumanRequestId, buildOverlay, buildPlanTree, canExecuteBridgeManagedComputeTask, canExecuteBridgeManagedStaticTask, cancel, cancelPendingTimersBridge, cleanupGenerations, computeDiffBundle, computeDiffBundleBetweenRefs, createSchedulerWakeQueue, createWorkflowVersioningRuntime, denyNode, dispatchWorkerTask, ensureSqlMessageStorage, ensureSqlMessageStorageEffect, executeChildWorkflow, executeComputeTaskBridge, executeStaticTaskBridge, executeTaskActivity, executeTaskBridge, executeTaskBridgeEffect, getDefinedToolMetadata, getHumanTaskPrompt, getRun, getSqlMessageStorage, getWorkflowMakeBridgeRuntime, getWorkflowPatchDecisions, getWorkflowVersioningRuntime, isBridgeManagedTimerTask, isBridgeManagedWaitForEventTask, isHumanRequestPastTimeout, isHumanTaskMeta, isPidAlive, isRunHeartbeatFresh, isTaskResultFailure, jsonSchemaToZod, listRuns, makeAbortError, makeApprovalDurableDeferred, makeDurableDeferredBridgeExecutionId, makeTaskActivity, makeTaskBridgeKey, makeWaitForEventDurableDeferred, makeWorkerTask, parseAttemptMetaJson, parseRuntimeOwnerPid, renderFrame, resolveDeferredTaskStateBridge, resolveOverlayEntry, resolveSchema, runWorkflow, runWorkflowWithMakeBridge, scheduleTasks, signal, signalRun, subscribeTaskWorkerDispatches, usePatched, validateHumanRequestValue, wireAbortSignal, withWorkflowMakeBridgeRuntime, withWorkflowVersioningRuntime };
