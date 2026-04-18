// @smithers-type-exports-begin
/** @typedef {import("@smithers-orchestrator/agents/capability-registry").AgentCapabilityRegistry} AgentCapabilityRegistry */
/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("@smithers-orchestrator/agents/capability-registry").AgentToolDescriptor} AgentToolDescriptor */
/** @typedef {import("@smithers-orchestrator/scorers").AggregateOptions} AggregateOptions */
/** @typedef {import("@smithers-orchestrator/scorers").AggregateScore} AggregateScore */
/**
 * @template CALL_OPTIONS
 * @template TOOLS
 * @typedef {import("@smithers-orchestrator/agents").AnthropicAgentOptions<CALL_OPTIONS, TOOLS>} AnthropicAgentOptions
 */
/** @typedef {import("@smithers-orchestrator/components").ApprovalAutoApprove} ApprovalAutoApprove */
/** @typedef {import("@smithers-orchestrator/components").ApprovalDecision} ApprovalDecision */
/** @typedef {import("@smithers-orchestrator/components").ApprovalMode} ApprovalMode */
/** @typedef {import("@smithers-orchestrator/components").ApprovalOption} ApprovalOption */
/** @typedef {import("@smithers-orchestrator/components").ApprovalProps} ApprovalProps */
/** @typedef {import("@smithers-orchestrator/components").ApprovalRanking} ApprovalRanking */
/** @typedef {import("@smithers-orchestrator/components").ApprovalRequest} ApprovalRequest */
/** @typedef {import("@smithers-orchestrator/components").ApprovalSelection} ApprovalSelection */
/** @typedef {import("@smithers-orchestrator/components").ColumnDef} ColumnDef */
/** @typedef {import("@smithers-orchestrator/server/gateway").ConnectRequest} ConnectRequest */
/** @typedef {import("@smithers-orchestrator/components").ContinueAsNewProps} ContinueAsNewProps */
/** @typedef {import("@smithers-orchestrator/scorers").CreateScorerConfig} CreateScorerConfig */
/**
 * @template Schema
 * @typedef {import("./CreateSmithersApi.ts").CreateSmithersApi<Schema>} CreateSmithersApi
 */
/** @typedef {import("@smithers-orchestrator/components").DepsSpec} DepsSpec */
/** @typedef {import("@smithers-orchestrator/server/gateway").EventFrame} EventFrame */
/**
 * @template S
 * @typedef {import("./external/ExternalSmithersConfig.ts").ExternalSmithersConfig<S>} ExternalSmithersConfig
 */
/** @typedef {import("@smithers-orchestrator/server/gateway").GatewayAuthConfig} GatewayAuthConfig */
/** @typedef {import("@smithers-orchestrator/server/gateway").GatewayDefaults} GatewayDefaults */
/** @typedef {import("@smithers-orchestrator/server/gateway").GatewayOptions} GatewayOptions */
/** @typedef {import("@smithers-orchestrator/server/gateway").GatewayTokenGrant} GatewayTokenGrant */
/** @typedef {import("@smithers-orchestrator/graph/GraphSnapshot").GraphSnapshot} GraphSnapshot */
/** @typedef {import("@smithers-orchestrator/server/gateway").HelloResponse} HelloResponse */
/** @typedef {import("@smithers-orchestrator/react-reconciler/dom/renderer").HostContainer} HostContainer */
/** @typedef {import("./external/HostNodeJson.ts").HostNodeJson} HostNodeJson */
/** @typedef {import("@smithers-orchestrator/components").InferDeps} InferDeps */
/**
 * @template T
 * @typedef {import("@smithers-orchestrator/driver/OutputAccessor").InferOutputEntry<T>} InferOutputEntry
 */
/**
 * @template TTable
 * @typedef {import("@smithers-orchestrator/driver/OutputAccessor").InferRow<TTable>} InferRow
 */
/** @typedef {import("@smithers-orchestrator/vcs/jj").JjRevertResult} JjRevertResult */
/** @typedef {import("@smithers-orchestrator/components").KanbanProps} KanbanProps */
/** @typedef {import("@smithers-orchestrator/errors/KnownSmithersErrorCode").KnownSmithersErrorCode} KnownSmithersErrorCode */
/** @typedef {import("@smithers-orchestrator/scorers").LlmJudgeConfig} LlmJudgeConfig */
/** @typedef {import("@smithers-orchestrator/memory").MemoryFact} MemoryFact */
/** @typedef {import("@smithers-orchestrator/memory").MemoryLayerConfig} MemoryLayerConfig */
/** @typedef {import("@smithers-orchestrator/memory").MemoryMessage} MemoryMessage */
/** @typedef {import("@smithers-orchestrator/memory").MemoryNamespace} MemoryNamespace */
/** @typedef {import("@smithers-orchestrator/memory").MemoryNamespaceKind} MemoryNamespaceKind */
/** @typedef {import("@smithers-orchestrator/memory").MemoryProcessor} MemoryProcessor */
/** @typedef {import("@smithers-orchestrator/memory").MemoryProcessorConfig} MemoryProcessorConfig */
/** @typedef {import("@smithers-orchestrator/memory").MemoryServiceApi} MemoryServiceApi */
/** @typedef {import("@smithers-orchestrator/memory").MemoryStore} MemoryStore */
/** @typedef {import("@smithers-orchestrator/memory").MemoryThread} MemoryThread */
/** @typedef {import("@smithers-orchestrator/memory").MessageHistoryConfig} MessageHistoryConfig */
/**
 * @template CALL_OPTIONS
 * @template TOOLS
 * @typedef {import("@smithers-orchestrator/agents").OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} OpenAIAgentOptions
 */
/** @typedef {import("@smithers-orchestrator/openapi").OpenApiAuth} OpenApiAuth */
/** @typedef {import("@smithers-orchestrator/openapi").OpenApiSpec} OpenApiSpec */
/** @typedef {import("@smithers-orchestrator/openapi").OpenApiToolsOptions} OpenApiToolsOptions */
/**
 * @template Schema
 * @typedef {import("@smithers-orchestrator/driver/OutputAccessor").OutputAccessor<Schema>} OutputAccessor
 */
/** @typedef {import("@smithers-orchestrator/driver/OutputKey").OutputKey} OutputKey */
/** @typedef {import("@smithers-orchestrator/components").OutputTarget} OutputTarget */
/** @typedef {import("@smithers-orchestrator/agents").PiAgentOptions} PiAgentOptions */
/** @typedef {import("@smithers-orchestrator/agents").PiExtensionUiRequest} PiExtensionUiRequest */
/** @typedef {import("@smithers-orchestrator/agents").PiExtensionUiResponse} PiExtensionUiResponse */
/** @typedef {import("@smithers-orchestrator/components").PollerProps} PollerProps */
/** @typedef {import("@smithers-orchestrator/server/gateway").RequestFrame} RequestFrame */
/** @typedef {import("@smithers-orchestrator/observability").ResolvedSmithersObservabilityOptions} ResolvedSmithersObservabilityOptions */
/** @typedef {import("@smithers-orchestrator/server/gateway").ResponseFrame} ResponseFrame */
/** @typedef {import("@smithers-orchestrator/time-travel/revert").RevertOptions} RevertOptions */
/** @typedef {import("@smithers-orchestrator/time-travel/revert").RevertResult} RevertResult */
/** @typedef {import("@smithers-orchestrator/vcs/jj").RunJjOptions} RunJjOptions */
/** @typedef {import("@smithers-orchestrator/vcs/jj").RunJjResult} RunJjResult */
/** @typedef {import("@smithers-orchestrator/driver/RunOptions").RunOptions} RunOptions */
/** @typedef {import("@smithers-orchestrator/driver/RunResult").RunResult} RunResult */
/** @typedef {import("@smithers-orchestrator/driver/RunStatus").RunStatus} RunStatus */
/** @typedef {import("@smithers-orchestrator/components").SagaProps} SagaProps */
/** @typedef {import("@smithers-orchestrator/components").SagaStepDef} SagaStepDef */
/** @typedef {import("@smithers-orchestrator/components").SagaStepProps} SagaStepProps */
/** @typedef {import("@smithers-orchestrator/scorers").SamplingConfig} SamplingConfig */
/** @typedef {import("@smithers-orchestrator/components").SandboxProps} SandboxProps */
/** @typedef {import("@smithers-orchestrator/components").SandboxRuntime} SandboxRuntime */
/** @typedef {import("@smithers-orchestrator/components").SandboxVolumeMount} SandboxVolumeMount */
/** @typedef {import("@smithers-orchestrator/components").SandboxWorkspaceSpec} SandboxWorkspaceSpec */
/** @typedef {import("@smithers-orchestrator/db/SchemaRegistryEntry").SchemaRegistryEntry} SchemaRegistryEntry */
/** @typedef {import("@smithers-orchestrator/scorers").Scorer} Scorer */
/** @typedef {import("@smithers-orchestrator/scorers").ScorerBinding} ScorerBinding */
/** @typedef {import("@smithers-orchestrator/scorers").ScorerContext} ScorerContext */
/** @typedef {import("@smithers-orchestrator/scorers").ScoreResult} ScoreResult */
/** @typedef {import("@smithers-orchestrator/scorers").ScorerFn} ScorerFn */
/** @typedef {import("@smithers-orchestrator/scorers").ScorerInput} ScorerInput */
/** @typedef {import("@smithers-orchestrator/scorers").ScoreRow} ScoreRow */
/** @typedef {import("@smithers-orchestrator/scorers").ScorersMap} ScorersMap */
/** @typedef {import("@smithers-orchestrator/memory").SemanticRecallConfig} SemanticRecallConfig */
/** @typedef {import("./external/SerializedCtx.ts").SerializedCtx} SerializedCtx */
/** @typedef {import("@smithers-orchestrator/server/serve").ServeOptions} ServeOptions */
/** @typedef {import("@smithers-orchestrator/server").ServerOptions} ServerOptions */
/** @typedef {import("@smithers-orchestrator/components").SignalProps} SignalProps */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertLabels} SmithersAlertLabels */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertPolicy} SmithersAlertPolicy */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyDefaults} SmithersAlertPolicyDefaults */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertPolicyRule} SmithersAlertPolicyRule */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertReaction} SmithersAlertReaction */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertReactionKind} SmithersAlertReactionKind */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertReactionRef} SmithersAlertReactionRef */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersAlertSeverity} SmithersAlertSeverity */
/** @typedef {import("@smithers-orchestrator/driver/SmithersCtx").SmithersCtx} SmithersCtx */
/** @typedef {import("@smithers-orchestrator/errors/SmithersError").SmithersError} SmithersError */
/** @typedef {import("@smithers-orchestrator/errors/SmithersErrorCode").SmithersErrorCode} SmithersErrorCode */
/** @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {import("@smithers-orchestrator/observability").SmithersLogFormat} SmithersLogFormat */
/** @typedef {import("@smithers-orchestrator/observability").SmithersObservabilityOptions} SmithersObservabilityOptions */
/** @typedef {import("@smithers-orchestrator/observability").SmithersObservabilityService} SmithersObservabilityService */
/**
 * @template Schema
 * @typedef {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<Schema>} SmithersWorkflow
 */
/** @typedef {import("@smithers-orchestrator/scheduler/SmithersWorkflowOptions").SmithersWorkflowOptions} SmithersWorkflowOptions */
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */
/** @typedef {import("@smithers-orchestrator/memory").TaskMemoryConfig} TaskMemoryConfig */
/** @typedef {import("@smithers-orchestrator/components").TaskProps} TaskProps */
/** @typedef {import("@smithers-orchestrator/components").TimerProps} TimerProps */
/** @typedef {import("@smithers-orchestrator/time-travel/timetravel").TimeTravelOptions} TimeTravelOptions */
/** @typedef {import("@smithers-orchestrator/time-travel/timetravel").TimeTravelResult} TimeTravelResult */
/** @typedef {import("@smithers-orchestrator/components").TryCatchFinallyProps} TryCatchFinallyProps */
/** @typedef {import("@smithers-orchestrator/components").WaitForEventProps} WaitForEventProps */
/**
 * @template T
 * @typedef {import("@smithers-orchestrator/memory").WorkingMemoryConfig<T>} WorkingMemoryConfig
 */
/** @typedef {import("@smithers-orchestrator/vcs/jj").WorkspaceAddOptions} WorkspaceAddOptions */
/** @typedef {import("@smithers-orchestrator/vcs/jj").WorkspaceInfo} WorkspaceInfo */
/** @typedef {import("@smithers-orchestrator/vcs/jj").WorkspaceResult} WorkspaceResult */
/** @typedef {import("@smithers-orchestrator/graph/XmlNode").XmlElement} XmlElement */
/** @typedef {import("@smithers-orchestrator/graph/XmlNode").XmlNode} XmlNode */
/** @typedef {import("@smithers-orchestrator/graph/XmlNode").XmlText} XmlText */
// @smithers-type-exports-end

export { hashCapabilityRegistry } from "@smithers-orchestrator/agents/capability-registry";
export { ERROR_REFERENCE_URL, } from "@smithers-orchestrator/errors/ERROR_REFERENCE_URL";
export { SmithersError as SmithersErrorInstance, } from "@smithers-orchestrator/errors/SmithersError";
export { errorToJson } from "@smithers-orchestrator/errors/errorToJson";
export { getSmithersErrorDefinition } from "@smithers-orchestrator/errors/getSmithersErrorDefinition";
export { getSmithersErrorDocsUrl } from "@smithers-orchestrator/errors/getSmithersErrorDocsUrl";
export { isKnownSmithersErrorCode } from "@smithers-orchestrator/errors/isKnownSmithersErrorCode";
export { isSmithersError } from "@smithers-orchestrator/errors/isSmithersError";
export { knownSmithersErrorCodes } from "@smithers-orchestrator/errors/knownSmithersErrorCodes";
// Components
export { Approval, approvalDecisionSchema, approvalRankingSchema, approvalSelectionSchema, Workflow, Task, Sequence, Parallel, MergeQueue, Branch, Loop, Ralph, ContinueAsNew, continueAsNew, Worktree, Sandbox, Kanban, Poller, Saga, TryCatchFinally, Signal, Timer, WaitForEvent, } from "@smithers-orchestrator/components";
// Agents
export { AnthropicAgent, OpenAIAgent, AmpAgent, ClaudeCodeAgent, CodexAgent, GeminiAgent, PiAgent, KimiAgent, ForgeAgent, } from "@smithers-orchestrator/agents";
// VCS
export { runJj, getJjPointer, revertToJjPointer, isJjRepo, workspaceAdd, workspaceList, workspaceClose, } from "@smithers-orchestrator/vcs/jj";
// Core API
export { createSmithers } from "./create.js";
export { runWorkflow, renderFrame } from "@smithers-orchestrator/engine";
export { signalRun } from "@smithers-orchestrator/engine/signals";
export { usePatched } from "@smithers-orchestrator/engine/effect/versioning";
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
export { startServer } from "@smithers-orchestrator/server";
export { Gateway } from "@smithers-orchestrator/server/gateway";
// Serve (Hono-based single-workflow HTTP server)
export { createServeApp } from "@smithers-orchestrator/server/serve";
// Observability
export { SmithersObservability, createSmithersObservabilityLayer, createSmithersOtelLayer, createSmithersRuntimeLayer, smithersMetrics, trackSmithersEvent, activeNodes, activeRuns, externalWaitAsyncPending, approvalsDenied, approvalsGranted, approvalsRequested, timerDelayDuration, timersCancelled, timersCreated, timersFired, timersPending, attemptDuration, cacheHits, cacheMisses, dbQueryDuration, dbRetries, dbTransactionDuration, dbTransactionRetries, dbTransactionRollbacks, hotReloadDuration, hotReloadFailures, hotReloads, httpRequestDuration, httpRequests, nodeDuration, nodesFailed, nodesFinished, nodesStarted, prometheusContentType, renderPrometheusMetrics, resolveSmithersObservabilityOptions, runsTotal, sandboxActive, sandboxBundleSizeBytes, sandboxCompletedTotal, sandboxCreatedTotal, sandboxDurationMs, sandboxPatchCount, sandboxTransportDurationMs, schedulerQueueDepth, toolCallsTotal, toolDuration, vcsDuration, } from "@smithers-orchestrator/observability";
// DB
export { SmithersDb } from "@smithers-orchestrator/db/adapter";
export { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
// Renderer
export { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
// External / multi-language
export { createExternalSmithers } from "./external/index.js";
// Revert
export { revertToAttempt } from "@smithers-orchestrator/time-travel/revert";
export { timeTravel } from "@smithers-orchestrator/time-travel/timetravel";
// Scorers
export { createScorer, llmJudge, relevancyScorer, toxicityScorer, faithfulnessScorer, schemaAdherenceScorer, latencyScorer, runScorersAsync, runScorersBatch, aggregateScores, smithersScorers, } from "@smithers-orchestrator/scorers";
// Memory
export { createMemoryStore, createMemoryLayer, MemoryService, TtlGarbageCollector, TokenLimiter, Summarizer, namespaceToString, parseNamespace, memoryFactReads, memoryFactWrites, memoryRecallQueries, memoryMessageSaves, memoryRecallDuration, } from "@smithers-orchestrator/memory";
// OpenAPI Tools
export { createOpenApiTools, createOpenApiToolsSync, createOpenApiTool, createOpenApiToolSync, listOperations, openApiToolCallsTotal, openApiToolCallErrorsTotal, openApiToolDuration, } from "@smithers-orchestrator/openapi";
// Utilities
export { mdxPlugin } from "./mdx-plugin.js";
export { markdownComponents } from "@smithers-orchestrator/components/markdownComponents";
export { renderMdx } from "@smithers-orchestrator/components/renderMdx";
export { zodToTable } from "@smithers-orchestrator/db/zodToTable";
export { zodToCreateTableSQL } from "@smithers-orchestrator/db/zodToCreateTableSQL";
export { camelToSnake } from "@smithers-orchestrator/db/utils/camelToSnake";
export { unwrapZodType } from "@smithers-orchestrator/db/unwrapZodType";
export { zodSchemaToJsonExample } from "@smithers-orchestrator/components/zod-to-example";
