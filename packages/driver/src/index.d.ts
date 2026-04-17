import { SmithersEvent } from '@smithers/observability/SmithersEvent';
import * as _smithers_graph_types from '@smithers/graph/types';
import { WorkflowGraph as WorkflowGraph$1, TaskDescriptor as TaskDescriptor$1 } from '@smithers/graph/types';
import * as _smithers_scheduler from '@smithers/scheduler';
import { WaitReason as WaitReason$1, EngineDecision as EngineDecision$1 } from '@smithers/scheduler';
import * as zod from 'zod';
import { z } from 'zod';
import { SmithersWorkflowOptions } from '@smithers/scheduler/SmithersWorkflowOptions';
import { SchemaRegistryEntry } from '@smithers/db/SchemaRegistryEntry';
import * as _smithers_graph from '@smithers/graph';
import { ExtractOptions, WorkflowGraph } from '@smithers/graph';

type RunAuthContext$2 = {
    triggeredBy: string;
    scopes: string[];
    role: string;
    createdAt: string;
};

type HotReloadOptions$1 = {
    /** Root directory to watch for changes (default: auto-detect from workflow entry) */
    rootDir?: string;
    /** Directory for generation overlays (default: .smithers/hmr/<runId>) */
    outDir?: string;
    /** Max overlay generations to keep (default: 3) */
    maxGenerations?: number;
    /** Whether to cancel tasks that become unmounted after hot reload (default: false) */
    cancelUnmounted?: boolean;
    /** Debounce interval in ms for file change events (default: 100) */
    debounceMs?: number;
};
type RunOptions$2 = {
    runId?: string;
    parentRunId?: string | null;
    input: Record<string, unknown>;
    maxConcurrency?: number;
    onProgress?: (e: SmithersEvent) => void;
    signal?: AbortSignal;
    resume?: boolean;
    force?: boolean;
    workflowPath?: string;
    rootDir?: string;
    logDir?: string | null;
    allowNetwork?: boolean;
    maxOutputBytes?: number;
    toolTimeoutMs?: number;
    hot?: boolean | HotReloadOptions$1;
    auth?: RunAuthContext$2 | null;
    config?: Record<string, unknown>;
    cliAgentToolsDefault?: "all" | "explicit-only";
    resumeClaim?: {
        claimOwnerId: string;
        claimHeartbeatAtMs: number;
        restoreRuntimeOwnerId?: string | null;
        restoreHeartbeatAtMs?: number | null;
    };
};

type RunStatus$1 = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "continued" | "failed" | "cancelled";

type RunResult$2 = {
    readonly runId: string;
    readonly status: RunStatus$1;
    readonly output?: unknown;
    readonly error?: unknown;
    readonly nextRunId?: string;
};

type ContinueAsNewHandler$1 = (transition: unknown, context: {
    runId: string;
    options: RunOptions$2;
}) => Promise<RunResult$2> | RunResult$2;

type CreateWorkflowSessionOptions = {
    db?: unknown;
    runId: string;
    rootDir?: string;
    workflowPath?: string | null;
    options: RunOptions$2;
};

type CreateWorkflowSession$1 = (opts: CreateWorkflowSessionOptions) => unknown;

type SchedulerWaitHandler$1 = (durationMs: number, context: {
    runId: string;
    tasks: readonly TaskDescriptor$1[];
}) => Promise<void> | void;

type TaskExecutorContext = {
    runId: string;
    options: RunOptions$2;
    signal?: AbortSignal;
};

type TaskExecutor$1 = (task: TaskDescriptor$1, context: TaskExecutorContext) => Promise<unknown> | unknown;

type WaitHandler$1 = (reason: WaitReason$1, context: {
    runId: string;
    options: RunOptions$2;
}) => Promise<EngineDecision$1 | RunResult$2> | EngineDecision$1 | RunResult$2;

type WorkflowRuntime$1 = {
    runPromise<A>(effect: unknown): Promise<A>;
};

type TaskCompletedEvent = {
    nodeId: string;
    iteration: number;
    output: unknown;
};

type TaskFailedEvent = {
    nodeId: string;
    iteration: number;
    error: unknown;
};

type WorkflowSession$1 = {
    submitGraph(graph: WorkflowGraph$1): unknown;
    taskCompleted(event: TaskCompletedEvent): unknown;
    taskFailed(event: TaskFailedEvent): unknown;
    getNextDecision?(): unknown;
    cancelRequested?(): unknown;
};

type InferRow<TTable> = TTable extends {
    $inferSelect: infer R;
} ? R : never;
type InferOutputEntry<T> = T extends z.ZodTypeAny ? z.infer<T> : T extends {
    $inferSelect: any;
} ? InferRow<T> : never;
type FallbackTableName<Schema> = [keyof Schema & string] extends [never] ? string : never;
type OutputAccessor$2<Schema> = {
    (table: FallbackTableName<Schema>): Array<any>;
    <K extends keyof Schema & string>(table: K): Array<InferOutputEntry<Schema[K]>>;
} & {
    [K in keyof Schema & string]: Array<InferOutputEntry<Schema[K]>>;
};

type SmithersRuntimeConfig$1 = {
    cliAgentToolsDefault?: "all" | "explicit-only";
};

type OutputSnapshot$2 = {
    [tableName: string]: Array<any>;
};

type SmithersCtxOptions$2 = {
    runId: string;
    iteration: number;
    iterations?: Record<string, number>;
    input: unknown;
    auth?: RunAuthContext$2 | null;
    outputs: OutputSnapshot$2;
    zodToKeyName?: Map<any, string>;
    runtimeConfig?: SmithersRuntimeConfig$1;
};

type SafeParser$1 = {
    safeParse(value: unknown): {
        success: true;
        data: unknown;
    } | {
        success: false;
        error?: unknown;
    };
};

type OutputKey$2 = {
    nodeId: string;
    iteration?: number;
};

/**
 * @template {unknown} [Schema=unknown]
 */
declare class SmithersCtx<Schema extends unknown = unknown> {
    /**
     * @param {SmithersCtxOptions} opts
     */
    constructor(opts: SmithersCtxOptions$1);
    /** @type {string} */
    runId: string;
    /** @type {number} */
    iteration: number;
    /** @type {Record<string, number> | undefined} */
    iterations: Record<string, number> | undefined;
    /** @type {Schema extends { input: infer T } ? T : any} */
    input: Schema extends {
        input: infer T;
    } ? T : any;
    /** @type {RunAuthContext | null} */
    auth: RunAuthContext$1 | null;
    /** @type {SmithersRuntimeConfig | null | undefined} */
    __smithersRuntime: SmithersRuntimeConfig | null | undefined;
    /** @type {OutputAccessor<Schema>} */
    outputs: OutputAccessor$1<Schema>;
    /** @type {import("./OutputSnapshot.ts").OutputSnapshot} */
    _outputs: OutputSnapshot$2;
    /** @type {Map<any, string> | undefined} */
    _zodToKeyName: Map<any, string> | undefined;
    /** @type {Set<string>} */
    _currentScopes: Set<string>;
    /**
     * @param {any} table
     * @param {OutputKey} key
     * @returns {any}
     */
    output(table: any, key: OutputKey$1): any;
    /**
     * @param {any} table
     * @param {OutputKey} key
     * @returns {any | undefined}
     */
    outputMaybe(table: any, key: OutputKey$1): any | undefined;
    /**
     * @param {any} table
     * @param {string} nodeId
     * @returns {any | undefined}
     */
    latest(table: any, nodeId: string): any | undefined;
    /**
     * @param {unknown} value
     * @param {SafeParser} schema
     * @returns {unknown[]}
     */
    latestArray(value: unknown, schema: SafeParser): unknown[];
    /**
     * @param {any} table
     * @param {string} nodeId
     * @returns {number}
     */
    iterationCount(table: any, nodeId: string): number;
    /**
     * @param {any} table
     * @returns {string}
     */
    resolveTableName(table: any): string;
    /**
     * @param {any} table
     * @param {OutputKey} key
     * @returns {any | undefined}
     */
    resolveRow(table: any, key: OutputKey$1): any | undefined;
}
type OutputKey$1 = OutputKey$2;
type SafeParser = SafeParser$1;
type SmithersCtxOptions$1 = SmithersCtxOptions$2;
type RunAuthContext$1 = RunAuthContext$2;
type SmithersRuntimeConfig = SmithersRuntimeConfig$1;
type OutputAccessor$1<Schema> = OutputAccessor$2<Schema>;

type WorkflowElement = {
    type: unknown;
    props: unknown;
    key: string | number | null;
};

type WorkflowSmithersCtx<Schema = unknown> = SmithersCtx<Schema>;
type WorkflowDefinition$1<Schema = unknown> = {
    readableName?: string;
    description?: string;
    db?: unknown;
    build: (ctx: WorkflowSmithersCtx<Schema>) => WorkflowElement;
    opts: SmithersWorkflowOptions;
    schemaRegistry?: Map<string, SchemaRegistryEntry>;
    zodToKeyName?: Map<zod.ZodObject<any>, string>;
};

type WorkflowGraphRenderer$1 = {
    render(element: WorkflowElement, opts?: ExtractOptions): Promise<WorkflowGraph> | WorkflowGraph;
};

type WorkflowDriverOptions$1<Schema = unknown> = {
    workflow: WorkflowDefinition$1<Schema>;
    runtime: WorkflowRuntime$1;
    renderer: WorkflowGraphRenderer$1;
    session?: WorkflowSession$1;
    createSession?: CreateWorkflowSession$1;
    db?: unknown;
    runId?: string;
    rootDir?: string;
    workflowPath?: string | null;
    executeTask?: TaskExecutor$1;
    onSchedulerWait?: SchedulerWaitHandler$1;
    onWait?: WaitHandler$1;
    continueAsNew?: ContinueAsNewHandler$1;
};

/**
 * @template {unknown} [Schema=unknown]
 */
declare class WorkflowDriver<Schema extends unknown = unknown> {
    /**
     * @param {import("./WorkflowDriverOptions.ts").WorkflowDriverOptions<Schema>} options
     */
    constructor(options: WorkflowDriverOptions$1<Schema>);
    /** @type {import("./WorkflowDefinition.ts").WorkflowDefinition<Schema>} */
    workflow: WorkflowDefinition$1<Schema>;
    /** @type {WorkflowRuntime} */
    runtime: WorkflowRuntime;
    /** @type {unknown} */
    db: unknown;
    /** @type {string | undefined} */
    configuredRunId: string | undefined;
    /** @type {string | undefined} */
    rootDir: string | undefined;
    /** @type {string | null | undefined} */
    workflowPath: string | null | undefined;
    /** @type {TaskExecutor} */
    executeTask: TaskExecutor;
    /** @type {SchedulerWaitHandler | undefined} */
    onSchedulerWait: SchedulerWaitHandler | undefined;
    /** @type {WaitHandler | undefined} */
    onWait: WaitHandler | undefined;
    /** @type {ContinueAsNewHandler | undefined} */
    continueAsNewHandler: ContinueAsNewHandler | undefined;
    /** @type {CreateWorkflowSession | undefined} */
    createSession: CreateWorkflowSession | undefined;
    /** @type {WorkflowGraphRenderer} */
    renderer: WorkflowGraphRenderer;
    /** @type {WorkflowSession | undefined} */
    session: WorkflowSession | undefined;
    /** @type {string} */
    activeRunId: string;
    /** @type {RunOptions | undefined} */
    activeOptions: RunOptions$1 | undefined;
    /** @type {import("@smithers/graph").WorkflowGraph | undefined} */
    lastGraph: _smithers_graph.WorkflowGraph | undefined;
    /** @type {Map<string, string>} */
    outputTablesByNodeId: Map<string, string>;
    /** @type {OutputSnapshot} */
    baseOutputs: OutputSnapshot$1;
    /**
   * @param {RunOptions} options
   * @returns {Promise<RunResult>}
   */
    run(options: RunOptions$1): Promise<RunResult$1>;
    /**
   * @param {string} runId
   * @param {RunOptions} options
   * @returns {Promise<WorkflowSession>}
   */
    initializeSession(runId: string, options: RunOptions$1): Promise<WorkflowSession>;
    /**
   * @param {RenderContext} context
   * @returns {Promise<EngineDecision>}
   */
    renderAndSubmit(context: RenderContext): Promise<EngineDecision>;
    /**
   * @param {readonly TaskDescriptor[]} tasks
   * @returns {Promise<EngineDecision | RunResult>}
   */
    executeTasks(tasks: readonly TaskDescriptor[]): Promise<EngineDecision | RunResult$1>;
    /**
   * @param {WaitReason} reason
   * @returns {Promise<EngineDecision | RunResult>}
   */
    handleWait(reason: WaitReason): Promise<EngineDecision | RunResult$1>;
    /**
   * @param {unknown} transition
   * @returns {Promise<RunResult>}
   */
    continueAsNew(transition: unknown): Promise<RunResult$1>;
    /**
   * @returns {Promise<RunResult>}
   */
    cancelRun(): Promise<RunResult$1>;
    /**
   * @template A
   * @param {unknown} effect
   * @returns {Promise<A>}
   */
    runEffect<A>(effect: unknown): Promise<A>;
}
type CreateWorkflowSession = CreateWorkflowSession$1;
type OutputSnapshot$1 = OutputSnapshot$2;
type WorkflowSession = WorkflowSession$1;
type WorkflowRuntime = WorkflowRuntime$1;
type WorkflowGraphRenderer = WorkflowGraphRenderer$1;
type TaskExecutor = TaskExecutor$1;
type SchedulerWaitHandler = SchedulerWaitHandler$1;
type WaitHandler = WaitHandler$1;
type ContinueAsNewHandler = ContinueAsNewHandler$1;
type RunOptions$1 = RunOptions$2;
type RunResult$1 = _smithers_scheduler.RunResult;
type EngineDecision = _smithers_scheduler.EngineDecision;
type RenderContext = _smithers_scheduler.RenderContext;
type WaitReason = _smithers_scheduler.WaitReason;
type TaskDescriptor = _smithers_graph_types.TaskDescriptor;

type HotReloadOptions = HotReloadOptions$1;
type OutputAccessor<Schema = any> = OutputAccessor$2<Schema>;
type OutputKey = OutputKey$2;
type OutputSnapshot = OutputSnapshot$2;
type RunAuthContext = RunAuthContext$2;
type RunOptions = RunOptions$2;
type RunResult = RunResult$2;
type RunStatus = RunStatus$1;
type SmithersCtxOptions = SmithersCtxOptions$2;
type WorkflowDefinition<Schema = unknown> = WorkflowDefinition$1<Schema>;
type WorkflowDriverOptions<Schema = unknown> = WorkflowDriverOptions$1<Schema>;

export { type HotReloadOptions, type InferOutputEntry, type OutputAccessor, type OutputKey, type OutputSnapshot, type RunAuthContext, type RunOptions, type RunResult, type RunStatus, SmithersCtx, type SmithersCtxOptions, type WorkflowDefinition, WorkflowDriver, type WorkflowDriverOptions, type WorkflowRuntime, type WorkflowSession };
