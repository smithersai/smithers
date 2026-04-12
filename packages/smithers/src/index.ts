// Types
export type { XmlNode, XmlElement, XmlText } from "@smithers/graph/XmlNode";
export type { AgentLike } from "@smithers/agents/AgentLike";
export type {
  AgentCapabilityRegistry,
  AgentToolDescriptor,
} from "@smithers/agents/capability-registry";
export { hashCapabilityRegistry } from "@smithers/agents/capability-registry";
export type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
export type { GraphSnapshot } from "@smithers/graph/GraphSnapshot";
export type { RunStatus } from "@smithers/driver/RunStatus";
export type { RunOptions } from "@smithers/driver/RunOptions";
export type { RunResult } from "@smithers/driver/RunResult";
export type { OutputKey } from "@smithers/driver/OutputKey";
export type {
  SmithersAlertLabels,
  SmithersAlertPolicy,
  SmithersAlertPolicyDefaults,
  SmithersAlertPolicyRule,
  SmithersAlertReaction,
  SmithersAlertReactionKind,
  SmithersAlertReactionRef,
  SmithersAlertSeverity,
  SmithersWorkflowOptions,
} from "@smithers/scheduler/SmithersWorkflowOptions";
export type { SchemaRegistryEntry } from "@smithers/db/SchemaRegistryEntry";
export type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
export type { SmithersCtx } from "@smithers/driver/SmithersCtx";
export type { OutputAccessor, InferRow, InferOutputEntry } from "@smithers/driver/OutputAccessor";
export type { SmithersEvent } from "@smithers/observability/SmithersEvent";
export type { SmithersError } from "@smithers/errors/SmithersError";
export {
  ERROR_REFERENCE_URL,
} from "@smithers/errors/ERROR_REFERENCE_URL";
export {
  SmithersError as SmithersErrorInstance,
} from "@smithers/errors/SmithersError";
export { errorToJson } from "@smithers/errors/errorToJson";
export { getSmithersErrorDefinition } from "@smithers/errors/getSmithersErrorDefinition";
export { getSmithersErrorDocsUrl } from "@smithers/errors/getSmithersErrorDocsUrl";
export { isKnownSmithersErrorCode } from "@smithers/errors/isKnownSmithersErrorCode";
export { isSmithersError } from "@smithers/errors/isSmithersError";
export { knownSmithersErrorCodes } from "@smithers/errors/knownSmithersErrorCodes";
export type { KnownSmithersErrorCode } from "@smithers/errors/KnownSmithersErrorCode";
export type { SmithersErrorCode } from "@smithers/errors/SmithersErrorCode";
export type {
  ResolvedSmithersObservabilityOptions,
  SmithersLogFormat,
  SmithersObservabilityOptions,
  SmithersObservabilityService,
} from "@smithers/observability";

// Components
export {
  Approval,
  approvalDecisionSchema,
  approvalRankingSchema,
  approvalSelectionSchema,
  Workflow,
  Task,
  Sequence,
  Parallel,
  MergeQueue,
  Branch,
  Loop,
  Ralph,
  ContinueAsNew,
  continueAsNew,
  Worktree,
  Sandbox,

  Kanban,
  Poller,
  Saga,
  TryCatchFinally,
  Signal,
  Timer,
  WaitForEvent,
} from "@smithers/components";
export type {
  ApprovalAutoApprove,
  ApprovalDecision,
  ApprovalMode,
  ApprovalOption,
  ApprovalProps,
  ApprovalRanking,
  ApprovalRequest,
  ApprovalSelection,
  ContinueAsNewProps,
  TaskProps,
  OutputTarget,
  DepsSpec,
  InferDeps,
  KanbanProps,
  ColumnDef,
  PollerProps,
  SagaProps,
  SagaStepDef,
  SagaStepProps,
  TryCatchFinallyProps,
  SignalProps,
  TimerProps,
  WaitForEventProps,
  SandboxProps,
  SandboxRuntime,
  SandboxVolumeMount,
  SandboxWorkspaceSpec,
} from "@smithers/components";

// Agents
export {
  AnthropicAgent,
  OpenAIAgent,
  AmpAgent,
  ClaudeCodeAgent,
  CodexAgent,
  GeminiAgent,
  PiAgent,
  KimiAgent,
  ForgeAgent,
} from "@smithers/agents";
export type {
  AnthropicAgentOptions,
  OpenAIAgentOptions,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiAgentOptions,
} from "@smithers/agents";

// VCS
export {
  runJj,
  getJjPointer,
  revertToJjPointer,
  isJjRepo,
  workspaceAdd,
  workspaceList,
  workspaceClose,
} from "@smithers/vcs/jj";
export type {
  RunJjOptions,
  RunJjResult,
  JjRevertResult,
  WorkspaceAddOptions,
  WorkspaceResult,
  WorkspaceInfo,
} from "@smithers/vcs/jj";

// Core API
export { createSmithers } from "./create";
export type { CreateSmithersApi } from "./create";
export { runWorkflow, renderFrame } from "@smithers/engine";
export { signalRun } from "@smithers/engine/signals";
export { usePatched } from "@smithers/engine/effect/versioning";

// Tools
export { getDefinedToolMetadata } from "@smithers/engine/getDefinedToolMetadata";

// Server
export { startServer } from "@smithers/server";
export type { ServerOptions } from "@smithers/server";
export { Gateway } from "@smithers/server/gateway";
export type {
  ConnectRequest,
  EventFrame,
  GatewayAuthConfig,
  GatewayDefaults,
  GatewayOptions,
  GatewayTokenGrant,
  HelloResponse,
  RequestFrame,
  ResponseFrame,
} from "@smithers/server/gateway";

// Serve (Hono-based single-workflow HTTP server)
export { createServeApp } from "@smithers/server/serve";
export type { ServeOptions } from "@smithers/server/serve";

// Observability
export {
  SmithersObservability,
  createSmithersObservabilityLayer,
  createSmithersOtelLayer,
  createSmithersRuntimeLayer,
  smithersMetrics,
  trackSmithersEvent,
  activeNodes,
  activeRuns,
  externalWaitAsyncPending,
  approvalsDenied,
  approvalsGranted,
  approvalsRequested,
  timerDelayDuration,
  timersCancelled,
  timersCreated,
  timersFired,
  timersPending,
  attemptDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
  dbTransactionDuration,
  dbTransactionRetries,
  dbTransactionRollbacks,
  hotReloadDuration,
  hotReloadFailures,
  hotReloads,
  httpRequestDuration,
  httpRequests,
  nodeDuration,
  nodesFailed,
  nodesFinished,
  nodesStarted,
  prometheusContentType,
  renderPrometheusMetrics,
  resolveSmithersObservabilityOptions,
  runsTotal,
  sandboxActive,
  sandboxBundleSizeBytes,
  sandboxCompletedTotal,
  sandboxCreatedTotal,
  sandboxDurationMs,
  sandboxPatchCount,
  sandboxTransportDurationMs,
  schedulerQueueDepth,
  toolCallsTotal,
  toolDuration,
  vcsDuration,
} from "@smithers/observability";

// DB
export { SmithersDb } from "@smithers/db/adapter";
export { ensureSmithersTables } from "@smithers/db/ensure";

// Renderer
export { SmithersRenderer } from "@smithers/react-reconciler/dom/renderer";
export type { HostContainer } from "@smithers/react-reconciler/dom/renderer";

// External / multi-language
export { createExternalSmithers } from "./external";
export type { ExternalSmithersConfig, SerializedCtx, HostNodeJson } from "./external";

// Revert
export { revertToAttempt } from "@smithers/time-travel/revert";
export type { RevertOptions, RevertResult } from "@smithers/time-travel/revert";
export { timeTravel } from "@smithers/time-travel/timetravel";
export type { TimeTravelOptions, TimeTravelResult } from "@smithers/time-travel/timetravel";


// Scorers
export {
  createScorer,
  llmJudge,
  relevancyScorer,
  toxicityScorer,
  faithfulnessScorer,
  schemaAdherenceScorer,
  latencyScorer,
  runScorersAsync,
  runScorersBatch,
  aggregateScores,
  smithersScorers,
} from "@smithers/scorers";
export type {
  ScoreResult,
  ScorerInput,
  ScorerFn,
  Scorer,
  SamplingConfig,
  ScorerBinding,
  ScorersMap,
  ScoreRow,
  AggregateScore,
  ScorerContext,
  CreateScorerConfig,
  LlmJudgeConfig,
  AggregateOptions,
} from "@smithers/scorers";



// Memory
export {
  createMemoryStore,
  createMemoryLayer,
  MemoryService,
  TtlGarbageCollector,
  TokenLimiter,
  Summarizer,
  namespaceToString,
  parseNamespace,
  memoryFactReads,
  memoryFactWrites,
  memoryRecallQueries,
  memoryMessageSaves,
  memoryRecallDuration,
} from "@smithers/memory";
export type {
  MemoryNamespace,
  MemoryNamespaceKind,
  MemoryFact,
  MemoryThread,
  MemoryMessage,
  MemoryStore,
  MemoryProcessor,
  MemoryServiceApi,
  MemoryLayerConfig,
  TaskMemoryConfig,
  WorkingMemoryConfig,
  SemanticRecallConfig,
  MessageHistoryConfig,
  MemoryProcessorConfig,
} from "@smithers/memory";

// OpenAPI Tools
export {
  createOpenApiTools,
  createOpenApiToolsSync,
  createOpenApiTool,
  createOpenApiToolSync,
  listOperations,
  openApiToolCallsTotal,
  openApiToolCallErrorsTotal,
  openApiToolDuration,
} from "@smithers/openapi";
export type {
  OpenApiSpec,
  OpenApiAuth,
  OpenApiToolsOptions,
} from "@smithers/openapi";

// Utilities
export { mdxPlugin } from "./mdx-plugin";
export { markdownComponents } from "@smithers/components/markdownComponents";
export { renderMdx } from "@smithers/components/renderMdx";
export { zodToTable } from "@smithers/db/zodToTable";
export { zodToCreateTableSQL } from "@smithers/db/zodToCreateTableSQL";
export { camelToSnake } from "@smithers/db/utils/camelToSnake";
export { unwrapZodType } from "@smithers/db/unwrapZodType";
export { zodSchemaToJsonExample } from "@smithers/components/zod-to-example";
