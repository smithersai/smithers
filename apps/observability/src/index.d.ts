import { Layer, Context, Effect, LogLevel, Metric, FiberRef } from 'effect';
import * as Tracer$1 from 'effect/Tracer';
import * as effect_Metric from 'effect/Metric';
import * as BunContext from '@effect/platform-bun/BunContext';
import * as effect_MetricState from 'effect/MetricState';
import * as effect_MetricKeyType from 'effect/MetricKeyType';

type SmithersLogFormat$1 = "json" | "pretty" | "string" | "logfmt";

type ResolvedSmithersObservabilityOptions$2 = {
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly serviceName: string;
    readonly logFormat: SmithersLogFormat$1;
    readonly logLevel: LogLevel.LogLevel;
};

type SmithersObservabilityService$1 = {
    readonly options: ResolvedSmithersObservabilityOptions$2;
    readonly annotate: (attributes: Readonly<Record<string, unknown>>) => Effect.Effect<void>;
    readonly withSpan: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Readonly<Record<string, unknown>>) => Effect.Effect<A, E, Exclude<R, Tracer$1.ParentSpan>>;
};

type SmithersObservabilityOptions$4 = {
    readonly enabled?: boolean;
    readonly endpoint?: string;
    readonly serviceName?: string;
    readonly logFormat?: SmithersLogFormat$1;
    readonly logLevel?: LogLevel.LogLevel | string;
};

type MetricLabels$1 = Readonly<Record<string, string | number | boolean>>;

type SmithersMetricType$1 = "counter" | "gauge" | "histogram";

type SmithersMetricUnit$1 = "count" | "milliseconds" | "seconds" | "bytes" | "tokens" | "ratio" | "depth";

type SmithersMetricDefinition$2 = {
    readonly key: string;
    readonly name: string;
    readonly prometheusName: string;
    readonly type: SmithersMetricType$1;
    readonly label: string;
    readonly unit?: SmithersMetricUnit$1;
    readonly labels?: readonly string[];
    readonly defaultLabels?: readonly MetricLabels$1[];
    readonly boundaries?: readonly number[];
};

type RunStatus = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "finished" | "continued" | "failed" | "cancelled";
type RunState = "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "recovering" | "stale" | "orphaned" | "failed" | "cancelled" | "succeeded" | "unknown";
type AgentCliActionKind = "turn" | "command" | "tool" | "file_change" | "web_search" | "todo_list" | "reasoning" | "warning" | "note";
type AgentCliActionPhase = "started" | "updated" | "completed";
type AgentCliEventLevel = "debug" | "info" | "warning" | "error";
type AgentCliStartedEvent = {
    type: "started";
    engine: string;
    title: string;
    resume?: string;
    detail?: Record<string, unknown>;
};
type AgentCliActionEvent = {
    type: "action";
    engine: string;
    phase: AgentCliActionPhase;
    entryType?: "thought" | "message";
    action: {
        id: string;
        kind: AgentCliActionKind;
        title: string;
        detail?: Record<string, unknown>;
    };
    message?: string;
    ok?: boolean;
    level?: AgentCliEventLevel;
};
type AgentCliCompletedEvent = {
    type: "completed";
    engine: string;
    ok: boolean;
    answer?: string;
    error?: string;
    resume?: string;
    usage?: Record<string, unknown>;
};
type AgentCliEvent = AgentCliStartedEvent | AgentCliActionEvent | AgentCliCompletedEvent;
type SmithersEvent$2 = {
    type: "SupervisorStarted";
    runId: string;
    pollIntervalMs: number;
    staleThresholdMs: number;
    timestampMs: number;
} | {
    type: "SupervisorPollCompleted";
    runId: string;
    staleCount: number;
    resumedCount: number;
    skippedCount: number;
    durationMs: number;
    timestampMs: number;
} | {
    type: "RunAutoResumed";
    runId: string;
    lastHeartbeatAtMs: number | null;
    staleDurationMs: number;
    timestampMs: number;
} | {
    type: "RunAutoResumeSkipped";
    runId: string;
    reason: "pid-alive" | "missing-workflow" | "rate-limited";
    timestampMs: number;
} | {
    type: "RunStarted";
    runId: string;
    timestampMs: number;
} | {
    type: "RunStatusChanged";
    runId: string;
    status: RunStatus;
    timestampMs: number;
} | {
    type: "RunStateChanged";
    runId: string;
    before: RunState;
    after: RunState;
    timestampMs: number;
} | {
    type: "RunFinished";
    runId: string;
    timestampMs: number;
} | {
    type: "RunFailed";
    runId: string;
    error: unknown;
    timestampMs: number;
} | {
    type: "RunCancelled";
    runId: string;
    timestampMs: number;
} | {
    type: "RunContinuedAsNew";
    runId: string;
    newRunId: string;
    iteration: number;
    carriedStateSize: number;
    ancestryDepth?: number;
    timestampMs: number;
} | {
    type: "RunHijackRequested";
    runId: string;
    target?: string;
    timestampMs: number;
} | {
    type: "RunHijacked";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    mode: "native-cli" | "conversation";
    resume?: string | null;
    cwd: string;
    timestampMs: number;
} | {
    type: "SandboxCreated";
    runId: string;
    sandboxId: string;
    runtime: "bubblewrap" | "docker" | "codeplane";
    configJson: string;
    timestampMs: number;
} | {
    type: "SandboxShipped";
    runId: string;
    sandboxId: string;
    runtime: "bubblewrap" | "docker" | "codeplane";
    bundleSizeBytes: number;
    timestampMs: number;
} | {
    type: "SandboxHeartbeat";
    runId: string;
    sandboxId: string;
    remoteRunId?: string;
    progress?: number;
    timestampMs: number;
} | {
    type: "SandboxBundleReceived";
    runId: string;
    sandboxId: string;
    bundleSizeBytes: number;
    patchCount: number;
    hasOutputs: boolean;
    timestampMs: number;
} | {
    type: "SandboxCompleted";
    runId: string;
    sandboxId: string;
    remoteRunId?: string;
    runtime: "bubblewrap" | "docker" | "codeplane";
    status: "finished" | "failed" | "cancelled";
    durationMs: number;
    timestampMs: number;
} | {
    type: "SandboxFailed";
    runId: string;
    sandboxId: string;
    runtime: "bubblewrap" | "docker" | "codeplane";
    error: unknown;
    timestampMs: number;
} | {
    type: "SandboxDiffReviewRequested";
    runId: string;
    sandboxId: string;
    patchCount: number;
    totalDiffLines: number;
    timestampMs: number;
} | {
    type: "SandboxDiffAccepted";
    runId: string;
    sandboxId: string;
    patchCount: number;
    timestampMs: number;
} | {
    type: "SandboxDiffRejected";
    runId: string;
    sandboxId: string;
    reason?: string;
    timestampMs: number;
} | {
    type: "FrameCommitted";
    runId: string;
    frameNo: number;
    xmlHash: string;
    timestampMs: number;
} | {
    type: "NodePending";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "NodeStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    timestampMs: number;
} | {
    type: "TaskHeartbeat";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    hasData: boolean;
    dataSizeBytes: number;
    intervalMs?: number;
    timestampMs: number;
} | {
    type: "TaskHeartbeatTimeout";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    lastHeartbeatAtMs: number;
    timeoutMs: number;
    timestampMs: number;
} | {
    type: "NodeFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    timestampMs: number;
} | {
    type: "NodeFailed";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    error: unknown;
    timestampMs: number;
} | {
    type: "NodeCancelled";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt?: number;
    reason?: string;
    timestampMs: number;
} | {
    type: "NodeSkipped";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "NodeRetrying";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    timestampMs: number;
} | {
    type: "NodeWaitingApproval";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "NodeWaitingTimer";
    runId: string;
    nodeId: string;
    iteration: number;
    firesAtMs: number;
    timestampMs: number;
} | {
    type: "ApprovalRequested";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "ApprovalGranted";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "ApprovalAutoApproved";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "ApprovalDenied";
    runId: string;
    nodeId: string;
    iteration: number;
    timestampMs: number;
} | {
    type: "ToolCallStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    toolName: string;
    seq: number;
    timestampMs: number;
} | {
    type: "ToolCallFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    toolName: string;
    seq: number;
    status: "success" | "error";
    timestampMs: number;
} | {
    type: "NodeOutput";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    text: string;
    stream: "stdout" | "stderr";
    timestampMs: number;
} | {
    type: "AgentEvent";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    engine: string;
    event: AgentCliEvent;
    timestampMs: number;
} | {
    type: "RetryTaskStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    resetDependents: boolean;
    resetNodes: string[];
    timestampMs: number;
} | {
    type: "RetryTaskFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    resetNodes: string[];
    success: boolean;
    error?: string;
    timestampMs: number;
} | {
    type: "RevertStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    jjPointer: string;
    timestampMs: number;
} | {
    type: "RevertFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    jjPointer: string;
    success: boolean;
    error?: string;
    timestampMs: number;
} | {
    type: "TimeTravelStarted";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    jjPointer?: string;
    timestampMs: number;
} | {
    type: "TimeTravelFinished";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    jjPointer?: string;
    success: boolean;
    vcsRestored: boolean;
    resetNodes: string[];
    error?: string;
    timestampMs: number;
} | {
    type: "TimeTravelJumped";
    runId: string;
    fromFrameNo: number;
    toFrameNo: number;
    timestampMs: number;
    caller?: string;
} | {
    type: "WorkflowReloadDetected";
    runId: string;
    changedFiles: string[];
    timestampMs: number;
} | {
    type: "WorkflowReloaded";
    runId: string;
    generation: number;
    changedFiles: string[];
    timestampMs: number;
} | {
    type: "WorkflowReloadFailed";
    runId: string;
    error: unknown;
    changedFiles: string[];
    timestampMs: number;
} | {
    type: "WorkflowReloadUnsafe";
    runId: string;
    reason: string;
    changedFiles: string[];
    timestampMs: number;
} | {
    type: "ScorerStarted";
    runId: string;
    nodeId: string;
    scorerId: string;
    scorerName: string;
    timestampMs: number;
} | {
    type: "ScorerFinished";
    runId: string;
    nodeId: string;
    scorerId: string;
    scorerName: string;
    score: number;
    timestampMs: number;
} | {
    type: "ScorerFailed";
    runId: string;
    nodeId: string;
    scorerId: string;
    scorerName: string;
    error: unknown;
    timestampMs: number;
} | {
    type: "TokenUsageReported";
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    model: string;
    agent: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    timestampMs: number;
} | {
    type: "SnapshotCaptured";
    runId: string;
    frameNo: number;
    contentHash: string;
    timestampMs: number;
} | {
    type: "RunForked";
    runId: string;
    parentRunId: string;
    parentFrameNo: number;
    branchLabel?: string;
    timestampMs: number;
} | {
    type: "ReplayStarted";
    runId: string;
    parentRunId: string;
    parentFrameNo: number;
    restoreVcs: boolean;
    timestampMs: number;
} | {
    type: "MemoryFactSet";
    runId: string;
    namespace: string;
    key: string;
    timestampMs: number;
} | {
    type: "MemoryRecalled";
    runId: string;
    namespace: string;
    query: string;
    resultCount: number;
    timestampMs: number;
} | {
    type: "MemoryMessageSaved";
    runId: string;
    threadId: string;
    role: string;
    timestampMs: number;
} | {
    type: "OpenApiToolCalled";
    runId: string;
    operationId: string;
    method: string;
    path: string;
    durationMs: number;
    status: "success" | "error";
    timestampMs: number;
} | {
    type: "TimerCreated";
    runId: string;
    timerId: string;
    firesAtMs: number;
    timerType: "duration" | "absolute";
    timestampMs: number;
} | {
    type: "TimerFired";
    runId: string;
    timerId: string;
    firesAtMs: number;
    firedAtMs: number;
    delayMs: number;
    timestampMs: number;
} | {
    type: "TimerCancelled";
    runId: string;
    timerId: string;
    timestampMs: number;
};

type MetricName = string;

type SmithersMetricEvent = {
    readonly type: string;
    readonly [key: string]: unknown;
};
type CounterEntry = {
    readonly type: "counter";
    value: number;
    readonly labels: MetricLabels$1;
};
type GaugeEntry = {
    readonly type: "gauge";
    value: number;
    readonly labels: MetricLabels$1;
};
type HistogramEntry = {
    readonly type: "histogram";
    sum: number;
    count: number;
    readonly labels: MetricLabels$1;
    readonly buckets: Map<number, number>;
};
type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;
type MetricsSnapshot$1 = ReadonlyMap<string, MetricEntry>;
type MetricsServiceShape$2 = {
    readonly increment: (name: MetricName, labels?: MetricLabels$1) => Effect.Effect<void>;
    readonly incrementBy: (name: MetricName, value: number, labels?: MetricLabels$1) => Effect.Effect<void>;
    readonly gauge: (name: MetricName, value: number, labels?: MetricLabels$1) => Effect.Effect<void>;
    readonly histogram: (name: MetricName, value: number, labels?: MetricLabels$1) => Effect.Effect<void>;
    readonly recordEvent: (event: SmithersMetricEvent) => Effect.Effect<void>;
    readonly updateProcessMetrics: () => Effect.Effect<void>;
    readonly updateAsyncExternalWaitPending: (kind: "approval" | "event", delta: number) => Effect.Effect<void>;
    readonly renderPrometheus: () => Effect.Effect<string>;
    readonly snapshot: () => Effect.Effect<MetricsSnapshot$1>;
};

type CorrelationContext$5 = {
    runId: string;
    nodeId?: string;
    iteration?: number;
    attempt?: number;
    workflowName?: string;
    parentRunId?: string;
    traceId?: string;
    spanId?: string;
};

type CorrelationPatch$5 = Partial<CorrelationContext$5> | undefined | null;

declare class MetricsService extends Context.TagClassShape<"MetricsService", MetricsServiceShape$2> {
}

declare class SmithersObservability extends Context.TagClassShape<"SmithersObservability", SmithersObservabilityService$1> {
}

declare const prometheusContentType: "text/plain; version=0.0.4; charset=utf-8";

declare namespace smithersSpanNames {
    let run: string;
    let task: string;
    let agent: string;
    let tool: string;
}

/**
 * @returns {Tracer.AnySpan | undefined}
 */
declare function getCurrentSmithersTraceSpan(): Tracer.AnySpan | undefined;

/**
 * @returns {| Readonly<Record<string, string>> | undefined}
 */
declare function getCurrentSmithersTraceAnnotations(): Readonly<Record<string, string>> | undefined;

/**
 * @typedef {Readonly<Record<string, unknown>>} SmithersSpanAttributesInput
 */
/**
 * @param {SmithersSpanAttributesInput} [attributes]
 * @returns {Record<string, unknown>}
 */
declare function makeSmithersSpanAttributes(attributes?: SmithersSpanAttributesInput): Record<string, unknown>;
type SmithersSpanAttributesInput = Readonly<Record<string, unknown>>;

/**
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @returns {Effect.Effect<void>}
 */
declare function annotateSmithersTrace(attributes?: Readonly<Record<string, unknown>>): Effect.Effect<void>;

/**
 * @template A, E, R
 * @param {string} name
 * @param {Effect.Effect<A, E, R>} effect
 * @param {Readonly<Record<string, unknown>>} [attributes]
 * @param {Omit<Tracer.SpanOptions, "attributes" | "kind"> & { readonly kind?: Tracer.SpanKind; }} [_options]
 * @returns {Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>}
 */
declare function withSmithersSpan<A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Readonly<Record<string, unknown>>, _options?: Omit<Tracer.SpanOptions, "attributes" | "kind"> & {
    readonly kind?: Tracer.SpanKind;
}): Effect.Effect<A, E, Exclude<R, Tracer.ParentSpan>>;

/**
 * @returns {string}
 */
declare function renderPrometheusMetrics(): string;

/**
 * @param {SmithersObservabilityOptions} [options]
 * @returns {ResolvedSmithersObservabilityOptions}
 */
declare function resolveSmithersObservabilityOptions(options?: SmithersObservabilityOptions$3): ResolvedSmithersObservabilityOptions$1;
type ResolvedSmithersObservabilityOptions$1 = ResolvedSmithersObservabilityOptions$2;
type SmithersObservabilityOptions$3 = SmithersObservabilityOptions$4;

declare const smithersMetrics: {
    [k: string]: effect_Metric.Metric<any, any, any>;
};

/** @type {Layer.Layer<MetricsService, never, never>} */
declare const MetricsServiceLive: Layer.Layer<MetricsService, never, never>;

/** @typedef {import("./SmithersObservabilityOptions.ts").SmithersObservabilityOptions} SmithersObservabilityOptions */
/**
 * @param {SmithersObservabilityOptions} [options]
 */
declare function createSmithersOtelLayer(options?: SmithersObservabilityOptions$2): Layer.Layer<never, never, never>;
type SmithersObservabilityOptions$2 = SmithersObservabilityOptions$4;

type TracingServiceShape = {
    readonly withSpan: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes?: Record<string, unknown>) => Effect.Effect<A, E, R>;
    readonly annotate: (attributes: Record<string, unknown>) => Effect.Effect<void>;
    readonly withCorrelation: <A, E, R>(context: CorrelationPatch$5, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

declare class TracingService extends Context.TagClassShape<"TracingService", TracingServiceShape> {
}
/** @type {Layer.Layer<TracingService, never, never>} */
declare const TracingServiceLive: Layer.Layer<TracingService, never, never>;

/**
 * @param {SmithersObservabilityOptions} [options]
 */
declare function createSmithersObservabilityLayer(options?: SmithersObservabilityOptions$1): Layer.Layer<MetricsService | TracingService | SmithersObservability | BunContext.BunContext, never, never>;
type SmithersObservabilityOptions$1 = SmithersObservabilityOptions$4;

declare const createSmithersRuntimeLayer: typeof createSmithersObservabilityLayer;

/**
 * @param {string} name
 * @returns {string}
 */
declare function toPrometheusMetricName(name: string): string;

/**
 * @returns {Effect.Effect<void>}
 */
declare function updateProcessMetrics(): Effect.Effect<void>;

/**
 * @param {SmithersEvent} event
 * @returns {Effect.Effect<void>}
 */
declare function trackEvent(event: SmithersEvent$1): Effect.Effect<void>;
type SmithersEvent$1 = SmithersEvent$2;

type SmithersMetricType = "counter" | "gauge" | "histogram";

type SmithersMetricUnit = "count" | "milliseconds" | "seconds" | "bytes" | "tokens" | "ratio" | "depth";

type SmithersMetricDefinition$1 = {
    readonly key: string;
    readonly metric: Metric.Metric<any, any, any>;
    readonly name: string;
    readonly prometheusName: string;
    readonly type: SmithersMetricType;
    readonly label: string;
    readonly unit?: SmithersMetricUnit;
    readonly description?: string;
    readonly labels?: readonly string[];
    readonly boundaries?: readonly number[];
    readonly defaultLabels?: readonly Readonly<Record<string, string>>[];
};

declare const smithersMetricCatalog: SmithersMetricDefinition$1[];

/** @type {MetricsServiceShape} */
declare const metricsServiceAdapter: MetricsServiceShape$1;
type MetricsServiceShape$1 = MetricsServiceShape$2;

declare const runsTotal: Metric.Metric.Counter<number>;

declare const nodesStarted: Metric.Metric.Counter<number>;

declare const nodesFinished: Metric.Metric.Counter<number>;

declare const nodesFailed: Metric.Metric.Counter<number>;

declare const toolCallsTotal: Metric.Metric.Counter<number>;

declare const cacheHits: Metric.Metric.Counter<number>;

declare const cacheMisses: Metric.Metric.Counter<number>;

declare const dbRetries: Metric.Metric.Counter<number>;

declare const dbTransactionRollbacks: Metric.Metric.Counter<number>;

declare const dbTransactionRetries: Metric.Metric.Counter<number>;

declare const hotReloads: Metric.Metric.Counter<number>;

declare const hotReloadFailures: Metric.Metric.Counter<number>;

declare const httpRequests: Metric.Metric.Counter<number>;

declare const approvalsRequested: Metric.Metric.Counter<number>;

declare const approvalsGranted: Metric.Metric.Counter<number>;

declare const approvalsDenied: Metric.Metric.Counter<number>;

declare const timersCreated: Metric.Metric.Counter<number>;

declare const timersFired: Metric.Metric.Counter<number>;

declare const timersCancelled: Metric.Metric.Counter<number>;

declare const sandboxCreatedTotal: Metric.Metric.Counter<number>;

declare const sandboxCompletedTotal: Metric.Metric.Counter<number>;

declare const scorerEventsStarted: Metric.Metric.Counter<number>;

declare const scorerEventsFinished: Metric.Metric.Counter<number>;

declare const scorerEventsFailed: Metric.Metric.Counter<number>;

declare const tokensInputTotal: Metric.Metric.Counter<number>;

declare const tokensOutputTotal: Metric.Metric.Counter<number>;

declare const tokensCacheReadTotal: Metric.Metric.Counter<number>;

declare const tokensCacheWriteTotal: Metric.Metric.Counter<number>;

declare const tokensReasoningTotal: Metric.Metric.Counter<number>;

declare const tokensContextWindowBucketTotal: Metric.Metric.Counter<number>;

declare const runsFinishedTotal: Metric.Metric.Counter<number>;

declare const runsFailedTotal: Metric.Metric.Counter<number>;

declare const runsCancelledTotal: Metric.Metric.Counter<number>;

declare const runsResumedTotal: Metric.Metric.Counter<number>;

declare const runsContinuedTotal: Metric.Metric.Counter<number>;

declare const errorsTotal: Metric.Metric.Counter<number>;

declare const nodeRetriesTotal: Metric.Metric.Counter<number>;

declare const toolCallErrorsTotal: Metric.Metric.Counter<number>;

declare const toolOutputTruncatedTotal: Metric.Metric.Counter<number>;

declare const eventsEmittedTotal: Metric.Metric.Counter<number>;

declare const activeRuns: Metric.Metric.Gauge<number>;

declare const activeNodes: Metric.Metric.Gauge<number>;

declare const schedulerQueueDepth: Metric.Metric.Gauge<number>;

declare const sandboxActive: Metric.Metric.Gauge<number>;

declare const approvalPending: Metric.Metric.Gauge<number>;

declare const externalWaitAsyncPending: Metric.Metric.Gauge<number>;

declare const timersPending: Metric.Metric.Gauge<number>;

declare const schedulerConcurrencyUtilization: Metric.Metric.Gauge<number>;

declare const processUptimeSeconds: Metric.Metric.Gauge<number>;

declare const processMemoryRssBytes: Metric.Metric.Gauge<number>;

declare const processHeapUsedBytes: Metric.Metric.Gauge<number>;

declare const nodeDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const attemptDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const toolDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const dbQueryDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const dbTransactionDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const httpRequestDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const hotReloadDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const vcsDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const tokensInputPerCall: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const tokensOutputPerCall: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const tokensContextWindowPerCall: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const runDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const promptSizeBytes: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const responseSizeBytes: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const approvalWaitDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const timerDelayDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const schedulerWaitDuration: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const runsAncestryDepth: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const runsCarriedStateBytes: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const sandboxDurationMs: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const sandboxBundleSizeBytes: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const sandboxTransportDurationMs: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const sandboxPatchCount: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const rewindTotal: Metric.Metric.Counter<number>;

declare const rewindRollbackTotal: Metric.Metric.Counter<number>;

declare const rewindDurationMs: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const rewindFramesDeleted: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const rewindSandboxesReverted: Metric.Metric<effect_MetricKeyType.MetricKeyType.Histogram, number, effect_MetricState.MetricState.Histogram>;

declare const correlationContextFiberRef: FiberRef.FiberRef<undefined>;

type CorrelationContextServiceShape = {
    readonly current: () => Effect.Effect<CorrelationContext$5 | undefined>;
    readonly withCorrelation: <A, E, R>(patch: CorrelationPatch$5, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    readonly toLogAnnotations: (context?: CorrelationContext$5 | null) => Record<string, unknown> | undefined;
};

declare class CorrelationContextService extends Context.TagClassShape<"CorrelationContextService", CorrelationContextServiceShape> {
}

/** @type {Layer.Layer<CorrelationContextService, never, never>} */
declare const CorrelationContextLive: Layer.Layer<CorrelationContextService, never, never>;

/**
 * @param {CorrelationContext | null} [base]
 * @param {CorrelationPatch} [patch]
 * @returns {CorrelationContext | undefined}
 */
declare function mergeCorrelationContext(base?: CorrelationContext$4 | null, patch?: CorrelationPatch$4): CorrelationContext$4 | undefined;
type CorrelationContext$4 = CorrelationContext$5;
type CorrelationPatch$4 = CorrelationPatch$5;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @returns {CorrelationContext | undefined}
 */
declare function getCurrentCorrelationContext(): CorrelationContext$3 | undefined;
type CorrelationContext$3 = CorrelationContext$5;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @returns {Effect.Effect< CorrelationContext | undefined >}
 */
declare function getCurrentCorrelationContextEffect(): Effect.Effect<CorrelationContext$2 | undefined>;
type CorrelationContext$2 = CorrelationContext$5;

/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/**
 * @template T
 * @param {CorrelationPatch} patch
 * @param {() => T} fn
 * @returns {T}
 */
declare function runWithCorrelationContext<T>(patch: CorrelationPatch$3, fn: () => T): T;
type CorrelationPatch$3 = CorrelationPatch$5;

/** @typedef {import("./CorrelationPatch.ts").CorrelationPatch} CorrelationPatch */
/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 * @param {CorrelationPatch} patch
 */
declare function withCorrelationContext<A, E, R>(effect: Effect.Effect<A, E, R>, patch: CorrelationPatch$2): Effect.Effect<A, E, R>;
type CorrelationPatch$2 = CorrelationPatch$5;

/**
 * @template A, E, R
 * @param {Effect.Effect<A, E, R>} effect
 */
declare function withCurrentCorrelationContext<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;

/** @typedef {import("./CorrelationContext.ts").CorrelationContext} CorrelationContext */
/**
 * @param {CorrelationContext | null} [context]
 * @returns {Record<string, unknown> | undefined}
 */
declare function correlationContextToLogAnnotations(context?: CorrelationContext$1 | null): Record<string, unknown> | undefined;
type CorrelationContext$1 = CorrelationContext$5;

/**
 * @param {CorrelationPatch} patch
 */
declare function updateCurrentCorrelationContext(patch: CorrelationPatch$1): void;
type CorrelationPatch$1 = CorrelationPatch$5;

/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logDebug(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logInfo(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logWarning(message: string, annotations?: LogAnnotations, span?: string): void;
/**
 * @param {string} message
 * @param {LogAnnotations} [annotations]
 * @param {string} [span]
 */
declare function logError(message: string, annotations?: LogAnnotations, span?: string): void;
type LogAnnotations = Record<string, unknown> | undefined;

type CorrelationContext = CorrelationContext$5;
type CorrelationPatch = CorrelationPatch$5;
type CorrelationContextPatch = CorrelationPatch;
type MetricLabels = MetricLabels$1;
type MetricsServiceShape = MetricsServiceShape$2;
type MetricsSnapshot = MetricsSnapshot$1;
type ResolvedSmithersObservabilityOptions = ResolvedSmithersObservabilityOptions$2;
type SmithersEvent = SmithersEvent$2;
type SmithersLogFormat = SmithersLogFormat$1;
type SmithersMetricDefinition = SmithersMetricDefinition$2;
type SmithersObservabilityOptions = SmithersObservabilityOptions$4;
type SmithersObservabilityService = SmithersObservabilityService$1;

export { type CorrelationContext, CorrelationContextLive, type CorrelationContextPatch, CorrelationContextService, type CorrelationPatch, type MetricLabels, MetricsService, MetricsServiceLive, type MetricsServiceShape, type MetricsSnapshot, type ResolvedSmithersObservabilityOptions, type SmithersEvent, type SmithersLogFormat, type SmithersMetricDefinition, SmithersObservability, type SmithersObservabilityOptions, type SmithersObservabilityService, TracingService, TracingServiceLive, activeNodes, activeRuns, annotateSmithersTrace, approvalPending, approvalWaitDuration, approvalsDenied, approvalsGranted, approvalsRequested, attemptDuration, cacheHits, cacheMisses, correlationContextFiberRef, correlationContextToLogAnnotations, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, errorsTotal, eventsEmittedTotal, externalWaitAsyncPending, getCurrentCorrelationContext, getCurrentCorrelationContextEffect, getCurrentSmithersTraceAnnotations, getCurrentSmithersTraceSpan, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, logDebug, logError, logInfo, logWarning, makeSmithersSpanAttributes, mergeCorrelationContext, metricsServiceAdapter, nodeDuration, nodeRetriesTotal, nodesFailed, nodesFinished, nodesStarted, processHeapUsedBytes, processMemoryRssBytes, processUptimeSeconds, prometheusContentType, promptSizeBytes, renderPrometheusMetrics, resolveSmithersObservabilityOptions, responseSizeBytes, rewindDurationMs, rewindFramesDeleted, rewindRollbackTotal, rewindSandboxesReverted, rewindTotal, runDuration, runWithCorrelationContext, runsAncestryDepth, runsCancelledTotal, runsCarriedStateBytes, runsContinuedTotal, runsFailedTotal, runsFinishedTotal, runsResumedTotal, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerConcurrencyUtilization, schedulerQueueDepth, schedulerWaitDuration, scorerEventsFailed, scorerEventsFinished, scorerEventsStarted, smithersMetricCatalog, smithersMetrics, smithersSpanNames, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, toPrometheusMetricName, tokensCacheReadTotal, tokensCacheWriteTotal, tokensContextWindowBucketTotal, tokensContextWindowPerCall, tokensInputPerCall, tokensInputTotal, tokensOutputPerCall, tokensOutputTotal, tokensReasoningTotal, toolCallErrorsTotal, toolCallsTotal, toolDuration, toolOutputTruncatedTotal, trackEvent as trackSmithersEvent, updateCurrentCorrelationContext, updateProcessMetrics, vcsDuration, withCorrelationContext, withCurrentCorrelationContext, withSmithersSpan };
