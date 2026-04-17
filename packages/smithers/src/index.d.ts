import * as _smithers_graph_XmlNode from '@smithers/graph/XmlNode';
import * as _smithers_time_travel_timetravel from '@smithers/time-travel/timetravel';
import * as _smithers_graph_TaskDescriptor from '@smithers/graph/TaskDescriptor';
import * as _smithers_components_SmithersWorkflow from '@smithers/components/SmithersWorkflow';
import { SmithersWorkflow as SmithersWorkflow$1 } from '@smithers/components/SmithersWorkflow';
import * as _smithers_observability_SmithersEvent from '@smithers/observability/SmithersEvent';
import { SmithersEvent as SmithersEvent$1 } from '@smithers/observability/SmithersEvent';
import * as _smithers_errors_SmithersErrorCode from '@smithers/errors/SmithersErrorCode';
import * as _smithers_errors_SmithersError from '@smithers/errors/SmithersError';
export { SmithersError as SmithersErrorInstance } from '@smithers/errors/SmithersError';
import * as _smithers_driver_SmithersCtx from '@smithers/driver/SmithersCtx';
import { SmithersCtx as SmithersCtx$1 } from '@smithers/driver/SmithersCtx';
import * as _smithers_scheduler_SmithersWorkflowOptions from '@smithers/scheduler/SmithersWorkflowOptions';
import { SmithersWorkflowOptions as SmithersWorkflowOptions$1, SmithersAlertPolicy as SmithersAlertPolicy$1 } from '@smithers/scheduler/SmithersWorkflowOptions';
import * as _smithers_server from '@smithers/server';
export { startServer } from '@smithers/server';
import * as _smithers_server_serve from '@smithers/server/serve';
export { createServeApp } from '@smithers/server/serve';
import { OutputSnapshot } from '@smithers/driver/OutputSnapshot';
import * as _smithers_db_SchemaRegistryEntry from '@smithers/db/SchemaRegistryEntry';
import * as _smithers_driver_RunStatus from '@smithers/driver/RunStatus';
import * as _smithers_driver_RunResult from '@smithers/driver/RunResult';
import * as _smithers_driver_RunOptions from '@smithers/driver/RunOptions';
import * as _smithers_time_travel_revert from '@smithers/time-travel/revert';
import * as _smithers_observability from '@smithers/observability';
export { SmithersObservability, activeNodes, activeRuns, approvalsDenied, approvalsGranted, approvalsRequested, attemptDuration, cacheHits, cacheMisses, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, externalWaitAsyncPending, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, nodeDuration, nodesFailed, nodesFinished, nodesStarted, prometheusContentType, renderPrometheusMetrics, resolveSmithersObservabilityOptions, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerQueueDepth, smithersMetrics, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, toolCallsTotal, toolDuration, trackSmithersEvent, vcsDuration } from '@smithers/observability';
import * as _smithers_driver_OutputKey from '@smithers/driver/OutputKey';
import * as _smithers_openapi from '@smithers/openapi';
export { createOpenApiTool, createOpenApiToolSync, createOpenApiTools, createOpenApiToolsSync, listOperations, openApiToolCallErrorsTotal, openApiToolCallsTotal, openApiToolDuration } from '@smithers/openapi';
import * as _smithers_memory from '@smithers/memory';
export { MemoryService, Summarizer, TokenLimiter, TtlGarbageCollector, createMemoryLayer, createMemoryStore, memoryFactReads, memoryFactWrites, memoryMessageSaves, memoryRecallDuration, memoryRecallQueries, namespaceToString, parseNamespace } from '@smithers/memory';
import * as _smithers_errors_KnownSmithersErrorCode from '@smithers/errors/KnownSmithersErrorCode';
import * as _smithers_vcs_jj from '@smithers/vcs/jj';
export { getJjPointer, isJjRepo, revertToJjPointer, runJj, workspaceAdd, workspaceClose, workspaceList } from '@smithers/vcs/jj';
import * as _smithers_driver_OutputAccessor from '@smithers/driver/OutputAccessor';
import * as _smithers_react_reconciler_dom_renderer from '@smithers/react-reconciler/dom/renderer';
export { SmithersRenderer } from '@smithers/react-reconciler/dom/renderer';
import * as _smithers_graph_GraphSnapshot from '@smithers/graph/GraphSnapshot';
import * as _smithers_agents_AgentLike from '@smithers/agents/AgentLike';
import { AgentLike as AgentLike$1 } from '@smithers/agents/AgentLike';
import * as zod from 'zod';
import { z } from 'zod';
import React from 'react';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as _smithers_components from '@smithers/components';
import { Sequence, Parallel, MergeQueue, Branch, Loop, Ralph, ContinueAsNew, continueAsNew, Worktree, Timer } from '@smithers/components';
export { Approval, Branch, ContinueAsNew, Kanban, Loop, MergeQueue, Parallel, Poller, Ralph, Saga, Sandbox, Sequence, Signal, Task, Timer, TryCatchFinally, WaitForEvent, Workflow, Worktree, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, continueAsNew } from '@smithers/components';
import { ApprovalProps as ApprovalProps$1 } from '@smithers/components/components/ApprovalProps';
import { DepsSpec as DepsSpec$1 } from '@smithers/components/components/DepsSpec';
import { SandboxProps as SandboxProps$1 } from '@smithers/components/components/SandboxProps';
import { SignalProps as SignalProps$1 } from '@smithers/components/components/SignalProps';
import { TaskProps as TaskProps$1 } from '@smithers/components/components/TaskProps';
import { WorkflowProps } from '@smithers/components/components/WorkflowProps';
import * as _smithers_server_gateway from '@smithers/server/gateway';
export { Gateway } from '@smithers/server/gateway';
import * as _smithers_agents from '@smithers/agents';
export { AmpAgent, AnthropicAgent, ClaudeCodeAgent, CodexAgent, ForgeAgent, GeminiAgent, KimiAgent, OpenAIAgent, PiAgent } from '@smithers/agents';
import * as _smithers_scorers from '@smithers/scorers';
export { aggregateScores, createScorer, faithfulnessScorer, latencyScorer, llmJudge, relevancyScorer, runScorersAsync, runScorersBatch, schemaAdherenceScorer, smithersScorers, toxicityScorer } from '@smithers/scorers';
import * as _smithers_agents_capability_registry from '@smithers/agents/capability-registry';
export { hashCapabilityRegistry } from '@smithers/agents/capability-registry';
export { ERROR_REFERENCE_URL } from '@smithers/errors/ERROR_REFERENCE_URL';
export { errorToJson } from '@smithers/errors/errorToJson';
export { getSmithersErrorDefinition } from '@smithers/errors/getSmithersErrorDefinition';
export { getSmithersErrorDocsUrl } from '@smithers/errors/getSmithersErrorDocsUrl';
export { isKnownSmithersErrorCode } from '@smithers/errors/isKnownSmithersErrorCode';
export { isSmithersError } from '@smithers/errors/isSmithersError';
export { knownSmithersErrorCodes } from '@smithers/errors/knownSmithersErrorCodes';
export { signalRun } from '@smithers/engine/signals';
export { usePatched } from '@smithers/engine/effect/versioning';
export { ensureSmithersTables } from '@smithers/db/ensure';
export { markdownComponents } from '@smithers/components/markdownComponents';
export { renderMdx } from '@smithers/components/renderMdx';
export { zodToTable } from '@smithers/db/zodToTable';
export { zodToCreateTableSQL } from '@smithers/db/zodToCreateTableSQL';
export { camelToSnake } from '@smithers/db/utils/camelToSnake';
export { unwrapZodType } from '@smithers/db/unwrapZodType';
export { zodSchemaToJsonExample } from '@smithers/components/zod-to-example';
export { renderFrame, runWorkflow } from '@smithers/engine';
import { Tool } from 'ai';
import { SmithersDb } from '@smithers/db/adapter';

type SerializedCtx$1 = {
    runId: string;
    iteration: number;
    iterations: Record<string, number>;
    input: unknown;
    outputs: OutputSnapshot;
};

type HostNodeJson$1 = {
    kind: "element";
    tag: string;
    props: Record<string, string>;
    rawProps: Record<string, any>;
    children: HostNodeJson$1[];
} | {
    kind: "text";
    text: string;
};

type ExternalSmithersConfig$2<S extends Record<string, z.ZodObject<z.ZodRawShape>>> = {
    schemas: S;
    agents: Record<string, AgentLike$1>;
    /** Synchronous build function that returns a HostNode JSON tree. */
    buildFn: (ctx: SerializedCtx$1) => HostNodeJson$1;
    dbPath?: string;
};

/** Union of all Zod schema values registered in the schema, constrained to ZodObject. */
type SchemaOutput<Schema> = Extract<Schema[keyof Schema], z.ZodObject<z.ZodRawShape>>;
type RuntimeSchema<Schema> = Schema extends {
    input: infer Input;
} ? Omit<Schema, "input"> & {
    input: Input extends z.ZodTypeAny ? z.infer<Input> : Input;
} : Schema;
type CreateSmithersApi$1<Schema = unknown> = {
    Workflow: (props: WorkflowProps) => React.ReactElement;
    Approval: <Row>(props: ApprovalProps$1<Row, SchemaOutput<Schema>>) => React.ReactElement;
    Task: <Row, D extends DepsSpec$1 = {}>(props: TaskProps$1<Row, SchemaOutput<Schema>, D>) => React.ReactElement;
    Sequence: typeof Sequence;
    Parallel: typeof Parallel;
    MergeQueue: typeof MergeQueue;
    Branch: typeof Branch;
    Loop: typeof Loop;
    Ralph: typeof Ralph;
    ContinueAsNew: typeof ContinueAsNew;
    continueAsNew: typeof continueAsNew;
    Worktree: typeof Worktree;
    Sandbox: (props: SandboxProps$1) => React.ReactElement;
    Signal: <SignalSchema extends z.ZodObject<z.ZodRawShape>>(props: SignalProps$1<SignalSchema>) => React.ReactElement;
    Timer: typeof Timer;
    useCtx: () => SmithersCtx$1<RuntimeSchema<Schema>>;
    smithers: (build: (ctx: SmithersCtx$1<RuntimeSchema<Schema>>) => React.ReactElement, opts?: SmithersWorkflowOptions$1) => SmithersWorkflow$1<RuntimeSchema<Schema>>;
    db: BunSQLiteDatabase<Record<string, unknown>>;
    tables: {
        [K in keyof Schema]: unknown;
    };
    outputs: {
        [K in keyof Schema]: Schema[K];
    };
};

type CreateSmithersOptions$1 = {
    readableName?: string;
    description?: string;
    alertPolicy?: SmithersAlertPolicy$1;
    dbPath?: string;
    journalMode?: string;
};

/**
 * Schema-driven API — users define only Zod schemas, the framework owns the entire storage layer.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} Schemas
 * @param {Schemas} schemas
 * @param {CreateSmithersOptions} [opts]
 * @returns {import("./CreateSmithersApi.ts").CreateSmithersApi<Schemas>}
 *
 * @example
 * ```ts
 * const { Workflow, Task, smithers, outputs } = createSmithers({
 *   discover: discoverOutputSchema,
 *   research: researchOutputSchema,
 * });
 *
 * export default smithers((ctx) => (
 *   <Workflow name="my-workflow">
 *     <Task id="discover" output={outputs.discover} agent={myAgent}>...</Task>
 *   </Workflow>
 * ));
 * ```
 */
declare function createSmithers<Schemas extends Record<string, zod.ZodObject<any>>>(schemas: Schemas, opts?: CreateSmithersOptions): CreateSmithersApi$1<Schemas>;
type CreateSmithersOptions = CreateSmithersOptions$1;

/**
 * Create a SmithersWorkflow from an external build function.
 *
 * Schemas and agents are defined in TS. The build function produces a HostNode JSON tree
 * that maps 1:1 to what the JSX renderer would produce.
 *
 * @template {Record<string, import("zod").ZodObject<any>>} S
 * @param {ExternalSmithersConfig<S>} config
 * @returns {import("@smithers/components/SmithersWorkflow").SmithersWorkflow<S> & { tables: Record<string, any>; cleanup: () => void }}
 */
declare function createExternalSmithers<S extends Record<string, zod.ZodObject<any>>>(config: ExternalSmithersConfig$1<S>): _smithers_components_SmithersWorkflow.SmithersWorkflow<S> & {
    tables: Record<string, any>;
    cleanup: () => void;
};
type ExternalSmithersConfig$1<S> = ExternalSmithersConfig$2<S>;

declare function mdxPlugin(): void;

type ToolContext = {
  db: SmithersDb;
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  idempotencyKey?: string | null;
  rootDir: string;
  allowNetwork: boolean;
  maxOutputBytes: number;
  timeoutMs: number;
  seq: number;
  emitEvent?: (event: SmithersEvent$1) => void | Promise<void>;
};

type DefinedToolContext = ToolContext & {
  idempotencyKey: string | null;
  toolName: string;
  sideEffect: boolean;
  idempotent: boolean;
};

type DefineToolOptions<Schema extends z.ZodTypeAny, Result> = {
  name: string;
  description?: string;
  schema: Schema;
  sideEffect?: boolean;
  idempotent?: boolean;
  execute: (
    args: z.infer<Schema>,
    ctx: DefinedToolContext,
  ) => Promise<Result> | Result;
};

type DefinedToolMetadata = {
  name: string;
  sideEffect: boolean;
  idempotent: boolean;
};

/**
 * A tool produced by {@link defineTool} — an `ai` SDK {@link Tool} whose input
 * type has been narrowed from its Zod schema and whose output type is the
 * caller-declared `Result`.
 */
type DefinedTool<Schema extends z.ZodTypeAny, Result> = Tool<
  z.infer<Schema>,
  Result
>;
declare function getDefinedToolMetadata(
  value: unknown,
): DefinedToolMetadata | null;
declare function defineTool<
  Schema extends z.ZodTypeAny,
  Result,
>(options: DefineToolOptions<Schema, Result>): DefinedTool<Schema, Result>;

declare const read: DefinedTool<
  z.ZodObject<{ path: z.ZodString }>,
  string
>;
declare const write: DefinedTool<
  z.ZodObject<{ path: z.ZodString; content: z.ZodString }>,
  "ok"
>;
declare const edit: DefinedTool<
  z.ZodObject<{ path: z.ZodString; patch: z.ZodString }>,
  "ok"
>;
declare const grep: DefinedTool<
  z.ZodObject<{ pattern: z.ZodString; path: z.ZodOptional<z.ZodString> }>,
  string
>;
declare const bash: DefinedTool<
  z.ZodObject<{
    cmd: z.ZodString;
    args: z.ZodOptional<z.ZodArray<z.ZodString>>;
    opts: z.ZodOptional<z.ZodObject<{ cwd: z.ZodOptional<z.ZodString> }>>;
  }>,
  string
>;
declare const tools: {
  read: typeof read;
  write: typeof write;
  edit: typeof edit;
  grep: typeof grep;
  bash: typeof bash;
};

type AgentCapabilityRegistry = _smithers_agents_capability_registry.AgentCapabilityRegistry;
type AgentLike = _smithers_agents_AgentLike.AgentLike;
type AgentToolDescriptor = _smithers_agents_capability_registry.AgentToolDescriptor;
type AggregateOptions = _smithers_scorers.AggregateOptions;
type AggregateScore = _smithers_scorers.AggregateScore;
type AnthropicAgentOptions<CALL_OPTIONS, TOOLS> = _smithers_agents.AnthropicAgentOptions<CALL_OPTIONS, TOOLS>;
type ApprovalAutoApprove = _smithers_components.ApprovalAutoApprove;
type ApprovalDecision = _smithers_components.ApprovalDecision;
type ApprovalMode = _smithers_components.ApprovalMode;
type ApprovalOption = _smithers_components.ApprovalOption;
type ApprovalProps = any;
type ApprovalRanking = _smithers_components.ApprovalRanking;
type ApprovalRequest = _smithers_components.ApprovalRequest;
type ApprovalSelection = _smithers_components.ApprovalSelection;
type ColumnDef = _smithers_components.ColumnDef;
type ConnectRequest = _smithers_server_gateway.ConnectRequest;
type ContinueAsNewProps = _smithers_components.ContinueAsNewProps;
type CreateScorerConfig = _smithers_scorers.CreateScorerConfig;
type CreateSmithersApi<Schema> = CreateSmithersApi$1<Schema>;
type DepsSpec = _smithers_components.DepsSpec;
type EventFrame = _smithers_server_gateway.EventFrame;
type ExternalSmithersConfig<S> = ExternalSmithersConfig$2<S>;
type GatewayAuthConfig = _smithers_server_gateway.GatewayAuthConfig;
type GatewayDefaults = _smithers_server_gateway.GatewayDefaults;
type GatewayOptions = _smithers_server_gateway.GatewayOptions;
type GatewayTokenGrant = _smithers_server_gateway.GatewayTokenGrant;
type GraphSnapshot = _smithers_graph_GraphSnapshot.GraphSnapshot;
type HelloResponse = _smithers_server_gateway.HelloResponse;
type HostContainer = _smithers_react_reconciler_dom_renderer.HostContainer;
type HostNodeJson = HostNodeJson$1;
type InferDeps = any;
type InferOutputEntry<T> = _smithers_driver_OutputAccessor.InferOutputEntry<T>;
type InferRow<TTable> = _smithers_driver_OutputAccessor.InferRow<TTable>;
type JjRevertResult = _smithers_vcs_jj.JjRevertResult;
type KanbanProps = _smithers_components.KanbanProps;
type KnownSmithersErrorCode = _smithers_errors_KnownSmithersErrorCode.KnownSmithersErrorCode;
type LlmJudgeConfig = _smithers_scorers.LlmJudgeConfig;
type MemoryFact = _smithers_memory.MemoryFact;
type MemoryLayerConfig = _smithers_memory.MemoryLayerConfig;
type MemoryMessage = _smithers_memory.MemoryMessage;
type MemoryNamespace = _smithers_memory.MemoryNamespace;
type MemoryNamespaceKind = _smithers_memory.MemoryNamespaceKind;
type MemoryProcessor = _smithers_memory.MemoryProcessor;
type MemoryProcessorConfig = _smithers_memory.MemoryProcessorConfig;
type MemoryServiceApi = _smithers_memory.MemoryServiceApi;
type MemoryStore = _smithers_memory.MemoryStore;
type MemoryThread = _smithers_memory.MemoryThread;
type MessageHistoryConfig = _smithers_memory.MessageHistoryConfig;
type OpenAIAgentOptions<CALL_OPTIONS, TOOLS> = _smithers_agents.OpenAIAgentOptions<CALL_OPTIONS, TOOLS>;
type OpenApiAuth = _smithers_openapi.OpenApiAuth;
type OpenApiSpec = _smithers_openapi.OpenApiSpec;
type OpenApiToolsOptions = _smithers_openapi.OpenApiToolsOptions;
type OutputAccessor<Schema> = _smithers_driver_OutputAccessor.OutputAccessor<Schema>;
type OutputKey = _smithers_driver_OutputKey.OutputKey;
type OutputTarget = _smithers_components.OutputTarget;
type PiAgentOptions = _smithers_agents.PiAgentOptions;
type PiExtensionUiRequest = _smithers_agents.PiExtensionUiRequest;
type PiExtensionUiResponse = _smithers_agents.PiExtensionUiResponse;
type PollerProps = _smithers_components.PollerProps;
type RequestFrame = _smithers_server_gateway.RequestFrame;
type ResolvedSmithersObservabilityOptions = _smithers_observability.ResolvedSmithersObservabilityOptions;
type ResponseFrame = _smithers_server_gateway.ResponseFrame;
type RevertOptions = _smithers_time_travel_revert.RevertOptions;
type RevertResult = _smithers_time_travel_revert.RevertResult;
type RunJjOptions = _smithers_vcs_jj.RunJjOptions;
type RunJjResult = _smithers_vcs_jj.RunJjResult;
type RunOptions = _smithers_driver_RunOptions.RunOptions;
type RunResult = _smithers_driver_RunResult.RunResult;
type RunStatus = _smithers_driver_RunStatus.RunStatus;
type SagaProps = _smithers_components.SagaProps;
type SagaStepDef = _smithers_components.SagaStepDef;
type SagaStepProps = _smithers_components.SagaStepProps;
type SamplingConfig = _smithers_scorers.SamplingConfig;
type SandboxProps = _smithers_components.SandboxProps;
type SandboxRuntime = _smithers_components.SandboxRuntime;
type SandboxVolumeMount = _smithers_components.SandboxVolumeMount;
type SandboxWorkspaceSpec = _smithers_components.SandboxWorkspaceSpec;
type SchemaRegistryEntry = _smithers_db_SchemaRegistryEntry.SchemaRegistryEntry;
type Scorer = _smithers_scorers.Scorer;
type ScorerBinding = _smithers_scorers.ScorerBinding;
type ScorerContext = _smithers_scorers.ScorerContext;
type ScoreResult = _smithers_scorers.ScoreResult;
type ScorerFn = _smithers_scorers.ScorerFn;
type ScorerInput = _smithers_scorers.ScorerInput;
type ScoreRow = _smithers_scorers.ScoreRow;
type ScorersMap = _smithers_scorers.ScorersMap;
type SemanticRecallConfig = _smithers_memory.SemanticRecallConfig;
type SerializedCtx = SerializedCtx$1;
type ServeOptions = _smithers_server_serve.ServeOptions;
type ServerOptions = _smithers_server.ServerOptions;
type SignalProps = any;
type SmithersAlertLabels = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertLabels;
type SmithersAlertPolicy = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertPolicy;
type SmithersAlertPolicyDefaults = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyDefaults;
type SmithersAlertPolicyRule = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertPolicyRule;
type SmithersAlertReaction = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertReaction;
type SmithersAlertReactionKind = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertReactionKind;
type SmithersAlertReactionRef = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertReactionRef;
type SmithersAlertSeverity = _smithers_scheduler_SmithersWorkflowOptions.SmithersAlertSeverity;
type SmithersCtx = _smithers_driver_SmithersCtx.SmithersCtx;
type SmithersError = _smithers_errors_SmithersError.SmithersError;
type SmithersErrorCode = _smithers_errors_SmithersErrorCode.SmithersErrorCode;
type SmithersEvent = _smithers_observability_SmithersEvent.SmithersEvent;
type SmithersLogFormat = _smithers_observability.SmithersLogFormat;
type SmithersObservabilityOptions = _smithers_observability.SmithersObservabilityOptions;
type SmithersObservabilityService = _smithers_observability.SmithersObservabilityService;
type SmithersWorkflow<Schema> = _smithers_components_SmithersWorkflow.SmithersWorkflow<Schema>;
type SmithersWorkflowOptions = _smithers_scheduler_SmithersWorkflowOptions.SmithersWorkflowOptions;
type TaskDescriptor = _smithers_graph_TaskDescriptor.TaskDescriptor;
type TaskMemoryConfig = _smithers_memory.TaskMemoryConfig;
type TaskProps = any;
type TimerProps = _smithers_components.TimerProps;
type TimeTravelOptions = _smithers_time_travel_timetravel.TimeTravelOptions;
type TimeTravelResult = _smithers_time_travel_timetravel.TimeTravelResult;
type TryCatchFinallyProps = _smithers_components.TryCatchFinallyProps;
type WaitForEventProps = _smithers_components.WaitForEventProps;
type WorkingMemoryConfig<T> = _smithers_memory.WorkingMemoryConfig<T>;
type WorkspaceAddOptions = _smithers_vcs_jj.WorkspaceAddOptions;
type WorkspaceInfo = _smithers_vcs_jj.WorkspaceInfo;
type WorkspaceResult = _smithers_vcs_jj.WorkspaceResult;
type XmlElement = _smithers_graph_XmlNode.XmlElement;
type XmlNode = _smithers_graph_XmlNode.XmlNode;
type XmlText = _smithers_graph_XmlNode.XmlText;

export { type AgentCapabilityRegistry, type AgentLike, type AgentToolDescriptor, type AggregateOptions, type AggregateScore, type AnthropicAgentOptions, type ApprovalAutoApprove, type ApprovalDecision, type ApprovalMode, type ApprovalOption, type ApprovalProps, type ApprovalRanking, type ApprovalRequest, type ApprovalSelection, type ColumnDef, type ConnectRequest, type ContinueAsNewProps, type CreateScorerConfig, type CreateSmithersApi, type DepsSpec, type EventFrame, type ExternalSmithersConfig, type GatewayAuthConfig, type GatewayDefaults, type GatewayOptions, type GatewayTokenGrant, type GraphSnapshot, type HelloResponse, type HostContainer, type HostNodeJson, type InferDeps, type InferOutputEntry, type InferRow, type JjRevertResult, type KanbanProps, type KnownSmithersErrorCode, type LlmJudgeConfig, type MemoryFact, type MemoryLayerConfig, type MemoryMessage, type MemoryNamespace, type MemoryNamespaceKind, type MemoryProcessor, type MemoryProcessorConfig, type MemoryServiceApi, type MemoryStore, type MemoryThread, type MessageHistoryConfig, type OpenAIAgentOptions, type OpenApiAuth, type OpenApiSpec, type OpenApiToolsOptions, type OutputAccessor, type OutputKey, type OutputTarget, type PiAgentOptions, type PiExtensionUiRequest, type PiExtensionUiResponse, type PollerProps, type RequestFrame, type ResolvedSmithersObservabilityOptions, type ResponseFrame, type RevertOptions, type RevertResult, type RunJjOptions, type RunJjResult, type RunOptions, type RunResult, type RunStatus, type SagaProps, type SagaStepDef, type SagaStepProps, type SamplingConfig, type SandboxProps, type SandboxRuntime, type SandboxVolumeMount, type SandboxWorkspaceSpec, type SchemaRegistryEntry, type ScoreResult, type ScoreRow, type Scorer, type ScorerBinding, type ScorerContext, type ScorerFn, type ScorerInput, type ScorersMap, type SemanticRecallConfig, type SerializedCtx, type ServeOptions, type ServerOptions, type SignalProps, type SmithersAlertLabels, type SmithersAlertPolicy, type SmithersAlertPolicyDefaults, type SmithersAlertPolicyRule, type SmithersAlertReaction, type SmithersAlertReactionKind, type SmithersAlertReactionRef, type SmithersAlertSeverity, type SmithersCtx, type SmithersError, type SmithersErrorCode, type SmithersEvent, type SmithersLogFormat, type SmithersObservabilityOptions, type SmithersObservabilityService, type SmithersWorkflow, type SmithersWorkflowOptions, type TaskDescriptor, type TaskMemoryConfig, type TaskProps, type TimeTravelOptions, type TimeTravelResult, type TimerProps, type TryCatchFinallyProps, type WaitForEventProps, type WorkingMemoryConfig, type WorkspaceAddOptions, type WorkspaceInfo, type WorkspaceResult, type XmlElement, type XmlNode, type XmlText, bash, createExternalSmithers, createSmithers, defineTool, edit, getDefinedToolMetadata, grep, mdxPlugin, read, tools, write };
