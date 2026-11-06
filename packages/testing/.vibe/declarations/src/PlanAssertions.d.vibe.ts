/**
 * Pure assertions for already-built plan graphs.
 *
 * @since 0.0.0
 */
import * as Effect from "effect/Effect";
import type { PlanLike } from "../../../src/PlanLike.ts";
import { PlanAssertionError } from "./TestingError.vibe";
/**
 * An expected placement: a bare tag, or a tag with an exact option payload.
 * When `options` is omitted only the tag is compared.
 *
 * @category models
 * @since 0.0.0
 */
export type PlacementExpectation = string | {
    readonly tag: string;
    readonly options?: Readonly<Record<string, unknown>> | undefined;
} | undefined;
/**
 * A plan edge accepted by {@link PlanAssertions.edges}.
 *
 * @category models
 * @since 0.0.0
 */
export type Edge = readonly [from: string, to: string] | {
    readonly from: string;
    readonly to: string;
};
/**
 * Options for edge assertions.
 *
 * @category models
 * @since 0.0.0
 */
export interface EdgeOptions {
    /** Whether the plan may contain edges outside the expected pairs. */
    readonly exact?: boolean | undefined;
}
/**
 * Options for static plan coverage assertions.
 *
 * @category models
 * @since 0.0.0
 */
export interface CoverageOptions {
    /** Node ids or `*` patterns which may be absent from the supplied plans. */
    readonly allowUnreached?: ReadonlyArray<string> | undefined;
}
/**
 * Fluent assertions scoped to a single built node.
 *
 * @category models
 * @since 0.0.0
 */
export interface NodeAssertions {
    /** Asserts the node's content-addressed key. */
    readonly key: (expected: string) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts the node's placement tag, and its option payload when given. */
    readonly placement: (expected: PlacementExpectation) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts the node's boundary mode. */
    readonly mode: (expected: string | undefined) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts the tier the node is keyed under. */
    readonly tier: (expected: string) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts the node's declared effects. */
    readonly declaresEffects: (expected: ReadonlyArray<string>) => Effect.Effect<void, PlanAssertionError>;
}
/**
 * Fluent assertions scoped to one built plan.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlanAssertions {
    /** Asserts the number of nodes. */
    readonly nodeCount: (expected: number) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts that a node id is present. */
    readonly contains: (id: string) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts required edges, and optionally the exact edge set. */
    readonly edges: (pairs: ReadonlyArray<Edge>, options?: EdgeOptions) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts node id to key mappings. */
    readonly keys: (expected: Readonly<Record<string, string>>) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts a node placement tag, and its option payload when given. */
    readonly placement: (id: string, expected: PlacementExpectation) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts a node's declared effects. */
    readonly declaresEffects: (id: string, expected: ReadonlyArray<string>) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts the plan envelope. */
    readonly envelope: (expected: Record<string, unknown> | undefined) => Effect.Effect<void, PlanAssertionError>;
    /** Asserts the canonical rendering equals an expected snapshot. */
    readonly matchesSnapshot: (expected: string) => Effect.Effect<void, PlanAssertionError>;
    /** Returns assertions scoped to a node. */
    readonly node: (id: string) => NodeAssertions;
}
/**
 * Fluent assertions across a static suite of built plans.
 *
 * @category models
 * @since 0.0.0
 */
export interface PlansAssertions {
    /** Asserts that the supplied suite reaches each requested node id. */
    readonly covers: (ids: ReadonlyArray<string>, options?: CoverageOptions) => Effect.Effect<void, PlanAssertionError>;
}
/**
 * Creates fluent pure assertions for a built plan.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const expectPlan: (plan: PlanLike) => PlanAssertions;
/**
 * Asserts key digests against checked-in goldens: the same logical input must
 * keep producing byte-identical `key1_` keys.
 *
 * @category assertions
 * @since 0.0.0
 */
export declare const expectKeyGoldens: (actual: Readonly<Record<string, string>>, golden: Readonly<Record<string, string>>) => Effect.Effect<void, PlanAssertionError>;
/**
 * Runs a plan computation that must be pure. Any failure or defect — for
 * example a poisoned Host or Model capability being reached during planning —
 * is surfaced as a `purity_violation` plan assertion error.
 *
 * The original value travels in `actual`, not only in the message. The
 * poisoned layers raise a `CapabilityContractError` carrying `capability` and
 * `operation` as typed fields precisely so a consumer can separate "the plan
 * called FileSystem.readFile" from "the plan called Jj.status" from "the input
 * schema failed to decode"; stringifying collapsed all three into prose a test
 * could only match with a regular expression.
 *
 * @category assertions
 * @since 0.0.0
 */
export declare const expectPure: <A, E, R>(computation: Effect.Effect<A, E, R>) => Effect.Effect<A, PlanAssertionError, R>;
/**
 * Creates static coverage assertions across built plans for a suite's inputs.
 *
 * @category constructors
 * @since 0.0.0
 */
export declare const expectPlans: (plans: ReadonlyArray<PlanLike>) => PlansAssertions;
