/**
 * The provider Model layer: provider-neutral requests and streaming events on
 * one side, protocol, endpoint, authentication and transport on the other.
 *
 * Modules are re-exported as namespaces, following `effect`'s index style,
 * so provider contracts and their constructors remain unambiguous. Every
 * namespace is also importable on its own subpath, `@smthrs/model/Route`.
 *
 * @since 0.1.0
 */

/**
 * @since 0.1.0
 * @slop
 */
export * as AnthropicMessages from "./AnthropicMessages.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as Auth from "./Auth.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as CanonicalJson from "./CanonicalJson.ts"

/**
 * @since 1.0.0-rc.0
 */
export * as Classifier from "./Classifier.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as DeferredTools from "./DeferredTools.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as Endpoint from "./Endpoint.vibe"

/**
 * @since 1.0.0-rc.0
 */
export * as Evaluator from "./Evaluator.vibe"

/**
 * @since 1.0.0-rc.1
 */
export * as EvaluatorBackup from "./EvaluatorBackup.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as Framing from "./Framing.vibe"

/** @since 1.0.0-rc.1 */
export * as FailureCopy from "./FailureCopy.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as Model from "./Model.vibe"

/**
 * @since 1.0.0-rc.0
 */
export * as ModelCatalog from "./ModelCatalog.ts"

/**
 * @since 0.1.0
 * @slop
 */
export * as ModelError from "./ModelError.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as ModelEvent from "./ModelEvent.ts"

/**
 * @since 1.0.0
 */
export * as ModelProxy from "./ModelProxy.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as ModelRequest from "./ModelRequest.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as OpenAIChatCompletions from "./OpenAIChatCompletions.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as OpenAIChatGPT from "./OpenAIChatGPT.vibe"

/**
 * @since 0.1.0
 * @slop
 */

/**
 * @since 0.1.0
 * @slop
 */
export * as OpenAIResponses from "./OpenAIResponses.vibe"

/**
 * @since 1.0.0-rc.1
 */
export * as Pricing from "./Pricing.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as Protocol from "./Protocol.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as RequestExecutor from "./RequestExecutor.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as Route from "./Route.vibe"

/**
 * @since 0.1.0
 * @slop
 */
export * as ToolStream from "./ToolStream.vibe"

/** @since 1.0.0 */
export * as WireTrace from "./WireTrace.vibe"
