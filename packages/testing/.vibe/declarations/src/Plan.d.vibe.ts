/**
 * Pure projection and presentation helpers for built plans.
 *
 * The graph is `@smthrs/flow`'s, the one graph builder, and the projection
 * reads exactly what its `GraphNode` carries. Keys are derived from each
 * node's draft material through `@smthrs/plan`'s step-key compiler: sealed
 * material gets a cross-run content key, every other tier gets a run-local
 * ordinal key. Plan projection is pure: it never touches Host, Model, or
 * Clock, and is expected to succeed under `TestLayers.poisoned`.
 *
 * @since 0.0.0
 */
import type * as Flow from "@smthrs/flow/Flow";
import * as Graph from "@smthrs/flow/Graph";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PlanLike, PlanNodeLike } from "../../../src/PlanLike.ts";
/**
 * Compatibility alias for the plan assertion node shape.
 *
 * @deprecated Use PlanNodeLike from `@smthrs/testing/PlanLike`.
 *
 * @category models
 * @since 0.0.0
 */
export type Node = PlanNodeLike;
/**
 * Compatibility alias for the plan assertion shape.
 *
 * @deprecated Use PlanLike from `@smthrs/testing/PlanLike`.
 *
 * @category models
 * @since 0.0.0
 */
export type Plan = PlanLike;
/**
 * Options for graph-local key derivation.
 *
 * @category models
 * @since 0.0.0
 */
export interface KeysOptions {
    /** Run identity used for ordinal (non-sealed) keys. Defaults to `"plan"`. */
    readonly runId?: string | undefined;
}
/**
 * Inputs needed to project a built graph into the testing assertion port.
 *
 * Keys are computed from each node's draft material by default. The `key`
 * resolver remains available only as a test override for fixtures that need
 * synthetic keys.
 *
 * @category models
 * @since 0.0.0
 */
export interface FromGraphOptions {
    /** Test-only override; omit to derive real keys from graph key material. */
    readonly key?: ((node: Graph.GraphNode) => string) | undefined;
    /** Run identity used for ordinal (non-sealed) keys. Defaults to `"plan"`. */
    readonly runId?: string | undefined;
    readonly envelope?: Record<string, unknown> | undefined;
    readonly digest?: string | undefined;
}
/**
 * Options accepted by {@link planOf}.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanOfOptions extends FromGraphOptions {
    readonly build?: Graph.BuildOptions | undefined;
}
/**
 * Derives every node's step key from the graph's draft key material.
 *
 * Sealed material becomes a content key via `StepKey.fromKeyMaterial`, with
 * dependency references resolved to previously derived keys in the graph's own
 * dependency order. Every other tier becomes a run-local ordinal key.
 *
 * The material is handed over verbatim, so a sealed node's key here is the key
 * the persisted plan records. A non-sealed node's is not: `Plan.compile`
 * fingerprints every declaration with `StepKey.planIdentity`, which keys a
 * non-sealed tier in the `plan-declaration` namespace, while this helper keys
 * it as the run-local `ordinal` the engine dispatches under.
 *
 * A graph holding a fatal build refusal has no drafts and therefore no keys;
 * `Graph.drafts` raises that refusal rather than keying a truncated topology.
 *
 * Keys hash through the injected `Crypto` service; the synchronous crypto
 * service keeps plan projection pure and total under `TestLayers.poisoned`.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const keys: (graph: Graph.Graph, options?: KeysOptions) => Record<string, string>;
/**
 * Projects `@smthrs/flow`'s graph introspection API into a PlanLike.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const fromGraph: (graph: Graph.Graph, options?: FromGraphOptions) => PlanLike;
/**
 * Decodes flow payload through the flow's declared payload schema, then builds
 * and projects the plan. Un-defaulted input cannot reach a plan: the schema's
 * defaults are applied by construction before planning sees the value.
 *
 * Building and projecting are pure — this succeeds under
 * `TestLayers.poisoned` and only ever fails on schema decoding.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const planOf: <F extends Flow.Any>(flow: F, input: unknown, options?: PlanOfOptions) => Effect.Effect<PlanLike, Schema.SchemaError, F["payloadSchema"]["DecodingServices"]>;
/**
 * Copies a built plan into a stable presentation order.
 *
 * Node ids, edge endpoints, keys, envelopes, and every other semantic field
 * are retained verbatim. This is intentionally not a graph traversal or a key
 * computation helper.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const make: (plan: PlanLike) => PlanLike;
/**
 * Renders a plan as a stable, line-oriented canonical string.
 *
 * Nodes and edges appear in the deterministic order of {@link make}; object
 * payloads render with sorted keys. Byte-identical output for semantically
 * identical plans makes this the substrate for snapshot assertions.
 *
 * @category formatting
 * @since 0.0.0
 */
export declare const render: (plan: PlanLike) => string;
/**
 * Returns the built node with the supplied id, if present.
 *
 * @category getters
 * @since 0.0.0
 */
export declare const node: (plan: PlanLike, id: string) => PlanNodeLike | undefined;
/**
 * Renders an edge as a stable, readable pair.
 *
 * @category formatting
 * @since 0.0.0
 */
export declare const edge: (value: PlanLike["edges"][number]) => string;
