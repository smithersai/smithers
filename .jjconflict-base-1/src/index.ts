// Types
export type { XmlNode, XmlElement, XmlText } from "./XmlNode";
export type { AgentLike } from "./AgentLike";
export type { TaskDescriptor } from "./TaskDescriptor";
export type { GraphSnapshot } from "./GraphSnapshot";
export type { RunStatus } from "./RunStatus";
export type { RunOptions } from "./RunOptions";
export type { RunResult } from "./RunResult";
export type { OutputKey } from "./OutputKey";
export type { SmithersWorkflowOptions } from "./SmithersWorkflowOptions";
export type { SchemaRegistryEntry } from "./SchemaRegistryEntry";
export type { SmithersWorkflow } from "./SmithersWorkflow";
export type { SmithersCtx } from "./SmithersCtx";
export type { OutputAccessor, InferRow, InferOutputEntry } from "./OutputAccessor";
export type { SmithersEvent } from "./SmithersEvent";
export type { SmithersError } from "./SmithersError";
export {
  ERROR_REFERENCE_URL,
  SmithersError as SmithersErrorInstance,
  errorToJson,
  getSmithersErrorDefinition,
  getSmithersErrorDocsUrl,
  isKnownSmithersErrorCode,
  isSmithersError,
  knownSmithersErrorCodes,
} from "./utils/errors";
export type { KnownSmithersErrorCode, SmithersErrorCode } from "./utils/errors";
export type {
  ResolvedSmithersObservabilityOptions,
  SmithersLogFormat,
  SmithersObservabilityOptions,
  SmithersObservabilityService,
} from "./observability";

// Components
export {
  Approval,
  approvalDecisionSchema,
  Workflow,
  Task,
  Sequence,
  Parallel,
  MergeQueue,
  Branch,
  Loop,
  Ralph,
  Worktree,
  Voice,
} from "./components";
export type {
  ApprovalDecision,
  ApprovalProps,
  ApprovalRequest,
  TaskProps,
  OutputTarget,
  DepsSpec,
  InferDeps,
} from "./components";

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
} from "./agents";
export type {
  AnthropicAgentOptions,
  OpenAIAgentOptions,
  PiExtensionUiRequest,
  PiExtensionUiResponse,
  PiAgentOptions,
} from "./agents";

// VCS
export {
  runJj,
  getJjPointer,
  revertToJjPointer,
  isJjRepo,
  workspaceAdd,
  workspaceList,
  workspaceClose,
} from "./vcs/jj";
export type {
  RunJjOptions,
  RunJjResult,
  JjRevertResult,
  WorkspaceAddOptions,
  WorkspaceResult,
  WorkspaceInfo,
} from "./vcs/jj";

// Core API
export { createSmithers } from "./create";
export type { CreateSmithersApi } from "./create";
export { runWorkflow, renderFrame } from "./engine";

// Tools
export { tools, read, write, edit, grep, bash } from "./tools/index";

// Server
export { startServer } from "./server/index";
export type { ServerOptions } from "./server/index";

// Serve (Hono-based single-workflow HTTP server)
export { createServeApp } from "./server/serve";
export type { ServeOptions } from "./server/serve";

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
  approvalsDenied,
  approvalsGranted,
  approvalsRequested,
  attemptDuration,
  cacheHits,
  cacheMisses,
  dbQueryDuration,
  dbRetries,
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
  schedulerQueueDepth,
  toolCallsTotal,
  toolDuration,
  vcsDuration,
} from "./observability";

// Effect builder (internal, includes SQLite helpers)
export { Smithers } from "./effect/builder";
export type { SmithersSqliteOptions } from "./effect/builder";

// DB
export { SmithersDb } from "./db/adapter";
export { ensureSmithersTables } from "./db/ensure";

// Renderer
export { SmithersRenderer } from "./dom/renderer";
export type { HostContainer } from "./dom/renderer";

// Revert
export { revertToAttempt } from "./revert";
export type { RevertOptions, RevertResult } from "./revert";


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
} from "./scorers";
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
} from "./scorers";

// Voice
export {
  createAiSdkVoice,
  createCompositeVoice,
  createOpenAIRealtimeVoice,
  VoiceService,
  speak,
  listen,
} from "./voice";
export type {
  VoiceProvider,
  SpeakOptions,
  ListenOptions,
  SendOptions,
  AudioFormat,
  TranscriptionResult,
  TranscriptionSegment,
  VoiceEventMap,
  VoiceEventType,
  VoiceEventCallback,
  AiSdkVoiceConfig,
  CompositeVoiceConfig,
  OpenAIRealtimeVoiceConfig,
} from "./voice";

// RAG
export {
  createDocument,
  loadDocument,
  chunk,
  embedChunks,
  embedQuery,
  createSqliteVectorStore,
  createRagPipeline,
  createRagTool,
  RagService,
  createRagServiceLayer,
  ragIngestCount,
  ragRetrieveCount,
  ragRetrieveDuration,
  ragEmbedDuration,
} from "./rag";
export type {
  Document as RagDocument,
  DocumentFormat,
  Chunk as RagChunk,
  ChunkStrategy,
  ChunkOptions,
  EmbeddedChunk,
  RetrievalResult,
  VectorStore,
  VectorQueryOptions,
  RagPipelineConfig,
  RagPipeline,
  CreateDocumentOptions,
  RagToolOptions,
} from "./rag";


// Memory
export {
  createMemoryStore,
  createSemanticMemory,
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
} from "./memory";
export type {
  MemoryNamespace,
  MemoryNamespaceKind,
  MemoryFact,
  MemoryThread,
  MemoryMessage,
  MemoryStore,
  SemanticMemory,
  MemoryProcessor,
  MemoryServiceApi,
  MemoryLayerConfig,
  TaskMemoryConfig,
  WorkingMemoryConfig,
  SemanticRecallConfig,
  MessageHistoryConfig,
  MemoryProcessorConfig,
} from "./memory";

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
} from "./openapi";
export type {
  OpenApiSpec,
  OpenApiAuth,
  OpenApiToolsOptions,
} from "./openapi";

// Utilities
export { mdxPlugin } from "./mdx-plugin";
export { markdownComponents } from "./markdownComponents";
export { renderMdx } from "./renderMdx";
export { zodToTable } from "./zodToTable";
export { zodToCreateTableSQL } from "./zodToCreateTableSQL";
export { camelToSnake } from "./utils/camelToSnake";
export { unwrapZodType } from "./unwrapZodType";
export { zodSchemaToJsonExample } from "./zod-to-example";
