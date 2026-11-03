/**
 * The one decoder from a planned model (@smthrs/rpc/ConfiguredModel) to the
 * real @smthrs/model stack: a generation plan becomes a Route, a decision plan
 * becomes an Evaluator layer. The plan never holds a value and the credential
 * arrives already Redacted, so nothing here can name one.
 *
 * Trusted host processes import this module; browser bundles do not carry the
 * kernel-backed model runtime.
 *
 * @since 1.0.0-rc.0
 */
import { HttpClient as KernelHttpClient } from "@smthrs/kernel";
import { Evaluator, type Model, ModelError, type ModelRequest, RequestExecutor, Route } from "@smthrs/model";
import type { ConfiguredModel } from "@smthrs/rpc";
import { Effect, Layer, Result } from "effect";
import type { Redacted } from "effect";
/**
 * Visits a route without erasing its protocol-specific type parameters.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface RouteVisitor<A> {
    <Body, Frame, Event, State>(route: Route.Route<Body, Frame, Event, State>): A;
}
/**
 * The plan's Route, handed to `visit`. `Route.anthropic` names its own origin,
 * so the plan's endpoint replaces it and the key header, the framing and the
 * `anthropic-version` header stay the package's own.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const withRoute: <A>(plan: ConfiguredModel.ModelPlan, apiKey: Redacted.Redacted<string>, given: RouteVisitor<A>) => Result.Result<A, ModelError.ModelError>;
/**
 * How {@link toModel} reaches the provider.
 *
 * @category models
 * @since 1.0.0
 */
export interface ToModelOptions {
    /** The fetch every call goes through; it never follows a redirect. Defaults to the runtime's global fetch. */
    readonly fetch?: typeof globalThis.fetch | undefined;
    /** Told the status of each provider redirect the transport refused. */
    readonly onRedirect?: ((status: number) => void) | undefined;
    /** Retries and the response-start deadline of each call; `RequestExecutor.makeWith`'s defaults when omitted. */
    readonly execution?: RequestExecutor.MakeOptions | undefined;
}
/**
 * The credential-free half of a configured route. `prepare` compiles a request
 * into exactly the url, public headers and body the model sends, before a
 * credential signs it, so a durable step can key on what was asked without
 * reaching the key. It is structurally `RouteResolver` from `@smthrs/agent`.
 *
 * @category models
 * @since 1.0.0
 */
export interface HostModelRoute {
    readonly prepare: (request: ModelRequest.ModelRequest) => Effect.Effect<Route.PreparedRequest, ModelError.ModelError>;
}
/**
 * The model a plan names, and the prepare port of the one route it streams through.
 *
 * @category models
 * @since 1.0.0
 */
export interface PlannedModel {
    readonly model: Model.Model;
    readonly route: HostModelRoute;
}
/**
 * Builds the model a validated generation plan names, with its redacted
 * credential, and the {@link HostModelRoute} of the same route. Every call
 * goes over a transport that refuses redirects (`providerTransport`), so the
 * key never leaves the planned origin. Only `prepare` leaves here, never the
 * route, whose `Auth` holds the key.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export declare const toModel: (plan: ConfiguredModel.ModelPlan, apiKey: Redacted.Redacted<string>, options?: ToModelOptions) => Effect.Effect<PlannedModel, ModelError.ModelError>;
/**
 * Builds the evaluator layer for a validated decision model plan.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export declare const toEvaluatorLayer: (plan: ConfiguredModel.ModelPlan, apiKey: Redacted.Redacted<string>, timeoutMs: number) => Layer.Layer<Evaluator.Evaluator, never, KernelHttpClient.HttpClient>;
