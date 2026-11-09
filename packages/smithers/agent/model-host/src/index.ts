/**
 * Shared model streaming, durable producer, and trusted host bindings.
 *
 * Every module here runs on every platform Smithers supports: Node, Bun, a
 * browser and a Cloudflare Worker. What only one platform can do is injected
 * by the host composition, never imported: the Node model host passes
 * `FetchTransport.observe` from `@smthrs/platform-node` as its
 * `CallbackTransportObserver`. Import from this root entry only.
 *
 * @since 1.0.0-rc.0
 */

export type {
  CallbackAttempt,
  CallbackTransport,
  CallbackTransportObserver,
  ObservedCallbackTransport
} from "./CallbackTransport.ts"
export {
  type HostModelRoute,
  type PlannedModel,
  type RouteVisitor,
  toEvaluatorLayer,
  toModel,
  type ToModelOptions,
  withRoute
} from "./ConfiguredModelRoute.vibe"
export { type ContextPreflightAnswer, runContextPreflight } from "./ContextPreflight.vibe"
export { type DurableChatGrant, DurableChatProducer, runDurableChatTurn } from "./DurableChatProducer.ts"
export { environmentModelResolver, type EnvironmentModelResolverOptions } from "./EnvironmentResolver.vibe"
export {
  createHostDiagnostics,
  type HostDiagnosticFields,
  type HostDiagnosticOptions,
  type HostDiagnostics,
  type HostDiagnosticValue,
  makeHostDiagnostics
} from "./HostDiagnostics.vibe"
export { HostModel, type HostModelOptions, type HostModelRecord, HostModelUnusable } from "./HostModel.vibe"
export {
  bearerAuthorization,
  createModelTurnHandler,
  MODEL_HOST_CONTEXT_SELECT_PATH,
  MODEL_HOST_HEALTH_PATH,
  MODEL_HOST_PROTOCOL,
  MODEL_HOST_STREAM_PATH,
  MODEL_HOST_TURN_PATH,
  type ModelTurnHandlerOptions,
  type ModelTurnResolution,
  type ModelTurnResolver
} from "./HostServer.ts"
export { type LocalPlanned, type ModelCredentials, modelFailureOf, planOnLocal } from "./LocalModel.vibe"
export {
  CommitRefused,
  type ProducerError,
  ProducerUnreachable,
  ProviderStartRefused,
  ReceiptMismatch,
  ResolveFailed,
  StreamTooLarge
} from "./ModelHostError.vibe"
export { createModelProbe, type ModelProbe, type ModelProbeOptions } from "./ModelProbe.vibe"
export {
  type FrameWriter,
  type HeldToolCall,
  type HeldToolCalls,
  type HostLeg,
  type ModelTurnOptions,
  runModelTurn,
  StreamingCredentialCutter
} from "./ModelTurnHost.vibe"
