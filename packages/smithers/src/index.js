// @smithers-type-exports-begin
/** @typedef {import("@smithers/agents/capability-registry").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("@smithers/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("@smithers/agents/capability-registry").AgentToolDescriptor} AgentToolDescriptor */
/** @typedef {import("@smithers/scorers").AggregateOptions} AggregateOptions */
/** @typedef {import("@smithers/scorers").AggregateScore} AggregateScore */
/**
 * @template CALL_OPTIONS
 * @template TOOLS
 * @typedef {import("@smithers/agents").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/** @typedef {import("@smithers/components").ApprovalAutoApprove} ApprovalAutoApprove */
/** @typedef {import("@smithers/components").ApprovalDecision} ApprovalDecision */
/** @typedef {import("@smithers/components").ApprovalMode} ApprovalMode */
/** @typedef {import("@smithers/components").ApprovalOption} ApprovalOption */
/** @typedef {import("@smithers/components").ApprovalProps} ApprovalProps */
/** @typedef {import("@smithers/components").ApprovalRanking} ApprovalRanking */
/** @typedef {import("@smithers/components").ApprovalRequest} ApprovalRequest */
/** @typedef {import("@smithers/components").ApprovalSelection} ApprovalSelection */
/** @typedef {import("@smithers/components").ColumnDef} ColumnDef */
/** @typedef {import("@smithers/server/gateway").ConnectRequest} ConnectRequest */
/** @typedef {import("@smithers/components").ContinueAsNewProps} ContinueAsNewProps */
/** @typedef {import("@smithers/scorers").CreateScorerConfig} CreateScorerConfig */
/**
 * @template Schema
 * @typedef {import("./CreateSmithersApi.ts").CreateSmithersApi<Schema>} CreateSmithersApi
 */
/** @typedef {import("@smithers/components").DepsSpec} DepsSpec */
/** @typedef {import("@smithers/server/gateway").EventFrame} EventFrame */
/**
 * @template S
 * @typedef {import("./external/ExternalSmithersConfig.ts").ExternalSmithersConfig<S>} ExternalSmithersConfig
 */
/** @typedef {import("@smithers/server/gateway").GatewayAuthConfig} GatewayAuthConfig */
/** @typedef {import("@smithers/server/gateway").GatewayDefaults} GatewayDefaults */
/** @typedef {import("@smithers/server/gateway").GatewayOptions} GatewayOptions */
/** @typedef {import("@smithers/server/gateway").GatewayTokenGrant} GatewayTokenGrant */
/** @typedef {import("@smithers/graph/GraphSnapshot").GraphSnapshot} GraphSnapshot */
/** @typedef {import("@smithers/server/gateway").HelloResponse} HelloResponse */
/** @typedef {import("@smithers/react-reconciler/dom/renderer").HostContainer} HostContainer */
/** @typedef {import("./external/HostNodeJson.ts").HostNodeJson} HostNodeJson */
/** @typedef {import("@smithers/components").InferDeps} InferDeps */
/**
 * @template T
 * @typedef {import("@smithers/driver/OutputAccessor").InferOutputEntry<T>} InferOutputEntry
 */
/**
 * @template TTable
 * @typedef {import("@smithers/driver/OutputAccessor").InferRow<TTable>} InferRow
 */
/** @typedef {import("@smithers/vcs/jj").JjRevertResult} JjRevertResult */
/** @typedef {import("@smithers/components").KanbanProps} KanbanProps */
/** @typedef {import("@smithers/errors/KnownSmithersErrorCode").KnownSmithersErrorCode} KnownSmithersErrorCode */
/** @typedef {import("@smithers/scorers").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("@smithers/memory").MemoryFact} MemoryFact */
/** @typedef {import("@smithers/memory").MemoryLayerConfig} MemoryLayerConfig */
/** @typedef {import("@smithers/memory").MemoryMessage} MemoryMessage */
/** @typedef {import("@smithers/memory").MemoryNamespace} MemoryNamespace */
/** @typedef {import("@smithers/memory").MemoryNamespaceKind} MemoryNamespaceKind */
/** @typedef {import("@smithers/memory").MemoryProcessor} MemoryProcessor */
/** @typedef {import("@smithers/memory").MemoryProcessorConfig} MemoryProcessorConfig */
/** @typedef {import("@smithers/memory").MemoryServiceApi} MemoryServiceApi */
/** @typedef {import("@smithers/memory").MemoryStore} MemoryStore */
/** @typedef {import("@smithers/memory").MemoryThread} MemoryThread */
/** @typedef {import("@smithers/memory").MessageHistoryConfig} MessageHistoryConfig */
/**
 * @template CALL_OPTIONS
 * @template TOOLS
 * @typedef {import("@smithers/agents").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
/** @typedef {import("@smithers/openapi").OpenApiAuth} OpenApiAuth */
/** @typedef {import("@smithers/openapi").OpenApiSpec} OpenApiSpec */
/** @typedef {import("@smithers/openapi").OpenApiToolsOptions} OpenApiToolsOptions */
/**
 * @template Schema
 * @typedef {import("@smithers/driver/OutputAccessor").OutputAccessor<Schema>} OutputAccessor
 */
/** @typedef {import("@smithers/driver/OutputKey").OutputKey} OutputKey */
/** @typedef {import("@smithers/components").OutputTarget} OutputTarget */
/** @typedef {import("@smithers/agents").PiAgentOptions} PiAgentOptions */
/** @typedef {import("@smithers/agents").PiExtensionUiRequest} PiExtensionUiRequest */
/** @typedef {import("@smithers/agents").PiExtensionUiResponse} PiExtensionUiResponse */
/** @typedef {import("@smithers/components").PollerProps} PollerProps */
/** @typedef {import("@smithers/server/gateway").RequestFrame} RequestFrame */
/** @typedef {import("@smithers/observability").ResolvedSmithersObservabilityOptions} ResolvedSmithersObservabilityOptions */
/** @typedef {import("@smithers/server/gateway").ResponseFrame} ResponseFrame */
/** @typedef {import("@smithers/time-travel/revert").RevertOptions} RevertOptions */
/** @typedef {import("@smithers/time-travel/revert").RevertResult} RevertResult */
/** @typedef {import("@smithers/vcs/jj").RunJjOptions} RunJjOptions */
/** @typedef {import("@smithers/vcs/jj").RunJjResult} RunJjResult */
/** @typedef {import("@smithers/driver/RunOptions").RunOptions} RunOptions */
/** @typedef {import("@smithers/driver/RunResult").RunResult} RunResult */
/** @typedef {import("@smithers/driver/RunStatus").RunStatus} RunStatus */
/** @typedef {import("@smithers/components").SagaProps} SagaProps */
/** @typedef {import("@smithers/components").SagaStepDef} SagaStepDef */
/** @typedef {import("@smithers/components").SagaStepProps} SagaStepProps */
/** @typedef {import("@smithers/scorers").SamplingConfig} SamplingConfig */
/** @typedef {import("@smithers/components").SandboxProps} SandboxProps */
/** @typedef {import("@smithers/components").SandboxRuntime} SandboxRuntime */
/** @typedef {import("@smithers/components").SandboxVolumeMount} SandboxVolumeMount */
/** @typedef {import("@smithers/components").SandboxWorkspaceSpec} SandboxWorkspaceSpec */
/** @typedef {import("@smithers/db/SchemaRegistryEntry").SchemaRegistryEntry} SchemaRegistryEntry */
/** @typedef {import("@smithers/scorers").Scorer} Scorer */
/** @typedef {import("@smithers/scorers").ScorerBinding} ScorerBinding */
/** @typedef {import("@smithers/scorers").ScorerContext} ScorerContext */
/** @typedef {import("@smithers/scorers").ScoreResult} ScoreResult */
/** @typedef {import("@smithers/scorers").ScorerFn} ScorerFn */
/** @typedef {import("@smithers/scorers").ScorerInput} ScorerInput */
/** @typedef {import("@smithers/scorers").ScoreRow} ScoreRow */
/** @typedef {import("@smithers/scorers").ScorersMap} ScorersMap */
/** @typedef {import("@smithers/memory").SemanticRecallConfig} SemanticRecallConfig */
/** @typedef {import("./external/SerializedCtx.ts").SerializedCtx} SerializedCtx */
/** @typedef {import("@smithers/server/serve").ServeOptions} ServeOptions */
/** @typedef {import("@smithers/server").ServerOptions} ServerOptions */
/** @typedef {import("@smithers/components").SignalProps} SignalProps */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertLabels} SmithersAlertLabels */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyDefaults} SmithersAlertPolicyDefaults */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyRule} SmithersAlertPolicyRule */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertReaction} SmithersAlertReaction */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertReactionKind} SmithersAlertReactionKind */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertReactionRef} SmithersAlertReactionRef */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersAlertSeverity} SmithersAlertSeverity */
/** @typedef {import("@smithers/driver/SmithersCtx").SmithersCtx} SmithersCtx */
/** @typedef {import("@smithers/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("@smithers/errors/SmithersErrorCode").SmithersErrorCode} SmithersErrorCode */
/** @typedef {import("@smithers/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("@smithers/observability").SmithersLogFormat} SmithersLogFormat */
/** @typedef {import("@smithers/observability").SmithersObservabilityOptions} SmithersObservabilityOptions */
/** @typedef {import("@smithers/observability").SmithersObservabilityService} SmithersObservabilityService */
/**
 * @template Schema
 * @typedef {import("@smithers/components/SmithersWorkflow").SmithersWorkflow<Schema>} SmithersWorkflow
 */
/** @typedef {import("@smithers/scheduler/SmithersWorkflowOptions").SmithersWorkflowOptions} SmithersWorkflowOptions */
/** @typedef {import("@smithers/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */
/** @typedef {import("@smithers/memory").TaskMemoryConfig} TaskMemoryConfig */
/** @typedef {import("@smithers/components").TaskProps} TaskProps */
/** @typedef {import("@smithers/components").TimerProps} TimerProps */
/** @typedef {import("@smithers/time-travel/timetravel").TimeTravelOptions} TimeTravelOptions */
/** @typedef {import("@smithers/time-travel/timetravel").TimeTravelResult} TimeTravelResult */
/** @typedef {import("@smithers/components").TryCatchFinallyProps} TryCatchFinallyProps */
/** @typedef {import("@smithers/components").WaitForEventProps} WaitForEventProps */
/**
 * @template T
 * @typedef {import("@smithers/memory").WorkingMemoryConfig<T>} WorkingMemoryConfig
 */
/** @typedef {import("@smithers/vcs/jj").WorkspaceAddOptions} WorkspaceAddOptions */
/** @typedef {import("@smithers/vcs/jj").WorkspaceInfo} WorkspaceInfo */
/** @typedef {import("@smithers/vcs/jj").WorkspaceResult} WorkspaceResult */
/** @typedef {import("@smithers/graph/XmlNode").XmlElement} XmlElement */
/** @typedef {import("@smithers/graph/XmlNode").XmlNode} XmlNode */
/** @typedef {import("@smithers/graph/XmlNode").XmlText} XmlText */
// @smithers-type-exports-end

export { hashCapabilityRegistry } from "@smithers/agents/capability-registry";
export { ERROR_REFERENCE_URL, } from "@smithers/errors/ERROR_REFERENCE_URL";
export { SmithersError as SmithersErrorInstance, } from "@smithers/errors/SmithersError";
export { errorToJson } from "@smithers/errors/errorToJson";
export { getSmithersErrorDefinition } from "@smithers/errors/getSmithersErrorDefinition";
export { getSmithersErrorDocsUrl } from "@smithers/errors/getSmithersErrorDocsUrl";
export { isKnownSmithersErrorCode } from "@smithers/errors/isKnownSmithersErrorCode";
export { isSmithersError } from "@smithers/errors/isSmithersError";
export { knownSmithersErrorCodes } from "@smithers/errors/knownSmithersErrorCodes";
// Components
export { Approval, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, Workflow, Task, Sequence, Parallel, MergeQueue, Branch, Loop, Ralph, ContinueAsNew, continueAsNew, Worktree, Sandbox, Kanban, Poller, Saga, TryCatchFinally, Signal, Timer, WaitForEvent, } from "@smithers/components";
// Agents
export { AnthropicAgent, OpenAIAgent, AmpAgent, ClaudeCodeAgent, CodexAgent, GeminiAgent, PiAgent, KimiAgent, ForgeAgent, } from "@smithers/agents";
// VCS
export { runJj, getJjPointer, revertToJjPointer, isJjRepo, workspaceAdd, workspaceList, workspaceClose, } from "@smithers/vcs/jj";
// Core API
export { createSmithers } from "./create.js";
export { runWorkflow, renderFrame } from "@smithers/engine";
export { signalRun } from "@smithers/engine/signals";
export { usePatched } from "@smithers/engine/effect/versioning";
// Tools
export {
  bash,
  defineTool,
  edit,
  getDefinedToolMetadata,
  grep,
  read,
  tools,
  write,
} from "./tools.js";
// Server
export { startServer } from "@smithers/server";
export { Gateway } from "@smithers/server/gateway";
// Serve (Hono-based single-workflow HTTP server)
export { createServeApp } from "@smithers/server/serve";
// Observability
export { SmithersObservability, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, smithersMetrics, trackSmithersEvent, activeNodes, activeRuns, externalWaitAsyncPending, approvalsDenied, approvalsGranted, approvalsRequested, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, attemptDuration, cacheHits, cacheMisses, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, nodeDuration, nodesFailed, nodesFinished, nodesStarted, prometheusContentType, renderPrometheusMetrics, resolveSmithersObservabilityOptions, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerQueueDepth, toolCallsTotal, toolDuration, vcsDuration, } from "@smithers/observability";
// DB
export { SmithersDb } from "@smithers/db/adapter";
export { ensureSmithersTables } from "@smithers/db/ensure";
// Renderer
export { SmithersRenderer } from "@smithers/react-reconciler/dom/renderer";
// External / multi-language
export { createExternalSmithers } from "./external/index.js";
// Revert
export { revertToAttempt } from "@smithers/time-travel/revert";
export { timeTravel } from "@smithers/time-travel/timetravel";
// Scorers
export { createScorer, llmJudge, relevancyScorer, toxicityScorer, faithfulnessScorer, schemaAdherenceScorer, latencyScorer, runScorersAsync, runScorersBatch, aggregateScores, smithersScorers, } from "@smithers/scorers";
// Memory
export { createMemoryStore, createMemoryLayer, MemoryService, TtlGarbageCollector, TokenLimiter, Summarizer, namespaceToString, parseNamespace, memoryFactReads, memoryFactWrites, memoryRecallQueries, memoryMessageSaves, memoryRecallDuration, } from "@smithers/memory";
// OpenAPI Tools
export { createOpenApiTools, createOpenApiToolsSync, createOpenApiTool, createOpenApiToolSync, listOperations, openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration, } from "@smithers/openapi";
// Utilities
export { mdxPlugin } from "./mdx-plugin.js";
export { markdownComponents } from "@smithers/components/markdownComponents";
export { renderMdx } from "@smithers/components/renderMdx";
export { zodToTable } from "@smithers/db/zodToTable";
export { zodToCreateTableSQL } from "@smithers/db/zodToCreateTableSQL";
export { camelToSnake } from "@smithers/db/utils/camelToSnake";
export { unwrapZodType } from "@smithers/db/unwrapZodType";
export { zodSchemaToJsonExample } from "@smithers/components/zod-to-example";
