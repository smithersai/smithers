/**
 * The shared machinery every composition pattern is built from: labelling a
 * pattern flow, refusing a bound it cannot build, and intersecting the effect
 * envelopes of the flows a pattern wraps.
 *
 * The envelope algebra comes straight from `@smthrs/plan/Effects`, the one
 * effect model: a decorator that narrows a wrapped flow's authority here and a
 * `Graph.build` that refuses a widening composition are reading the same
 * declaration through the same rule, not two rules that happen to agree.
 *
 * @since 0.1.0
 */
import * as Effects from "@smthrs/plan/Effects";
import type * as Schema from "effect/Schema";
import { PatternError } from "../PatternError.ts";
/**
 * @since 0.1.0
 * @private
 */
export interface EffectIntersection {
    readonly declaration: Effects.Declaration | undefined;
    readonly reads: ReadonlyArray<string>;
    readonly writes: ReadonlyArray<string>;
    readonly mode: boolean;
    readonly tier: boolean;
}
/**
 * Whether `value` is an object whose OWN `key` is exactly `true`.
 *
 * Every verdict a pattern stops or accepts on is read through this, so an
 * inherited property, such as one on a polluted prototype, is never a verdict.
 *
 * @since 1.0.0
 * @private
 */
export declare const ownTrue: (value: unknown, key: string) => boolean;
/**
 * Reads the shared acceptance vocabulary using own properties only.
 *
 * @since 0.1.0
 * @private
 */
export declare const accepted: (value: unknown) => boolean;
/**
 * Refuses a priority before a pattern sorts, annotates, or runs its member.
 *
 * @since 1.0.0
 * @private
 */
export declare const safeIntegerPriorityRefusal: (pattern: string, member: string, value: unknown) => PatternError | undefined;
/**
 * Refuses a width bound that is not a positive safe integer.
 *
 * Every pattern that bounds how many members are in flight refuses the same
 * values with the same sentence, so the sentence is stated once and named by
 * the pattern that declared the bound. What counts as "no bound at all"
 * differs per pattern, so each caller answers that before asking: `Panel`
 * reads an absent option and `Quarantine` reads the literal `"unbounded"`.
 *
 * @since 1.0.0
 * @private
 */
export declare const concurrencyRefusal: (pattern: string, concurrency: number) => PatternError | undefined;
/**
 * Refuses a member record a pattern cannot compose because it holds nothing.
 *
 * @since 1.0.0
 * @private
 */
export declare const nonEmptyMembersRefusal: (pattern: string, names: ReadonlyArray<string>) => PatternError | undefined;
/**
 * Refuses a declared bound whose unrolling can never be built into a plan.
 *
 * A pattern that unrolls a bound sequences `callsPerUnit` calls per unit into
 * a left-nested chain, so the plan nests one level deeper per call.
 * `@smthrs/flow`'s `Graph.build`, the builder that executes these
 * declarations, refuses a plan nested past its exported
 * `Graph.maximumGraphDepth` with a `graph_too_deep` `GraphBuildError` naming
 * the node, which names neither the option nor the pattern that produced it.
 * Refusing at the declaration names both, and reads the same constant the
 * builder does, so the two can never drift apart.
 *
 * The arithmetic: the flow's own root is one level, each of the `value` units
 * nests `callsPerUnit` more, and the value the chain settles with sits one
 * unit below the last one, so the deepest node is
 * `callsPerUnit * (value + 1) + 1`. The largest bound that still builds is the
 * largest `value` keeping that at or under the builder's limit.
 *
 * The limit counts the chain alone. Deeper member flows, or an enclosing
 * pattern that unrolls this one, spend the same budget, so a bound under the
 * limit can still be refused by `Graph.build`.
 *
 * @since 1.0.0
 * @private
 */
export declare const sequencedBoundRefusal: (pattern: string, option: string, value: number, callsPerUnit: number) => PatternError | undefined;
/**
 * @since 0.1.0
 * @private
 */
export declare const intersectEffects: (template: Effects.Declaration | undefined, supplied: Effects.Declaration | undefined) => EffectIntersection;
/**
 * @since 0.1.0
 * @private
 */
export declare const intersectCapabilities: (template: ReadonlyArray<string>, supplied: ReadonlyArray<string>) => ReadonlyArray<string>;
type SchemaSide = "input" | "output";
type SchemaCompatibilityIssue = {
    readonly _tag: "IncompatibleSchemas";
    readonly side: SchemaSide;
    readonly expectedTag: string;
    readonly actualTag: string;
    readonly path: string | undefined;
} | {
    readonly _tag: "SchemaConversionFailed";
    readonly side: SchemaSide;
    readonly schema: "expected" | "actual";
    readonly tag: string;
};
/**
 * Compares a declared input and output pair against the pair another
 * declaration states, whatever shape the declaration itself has.
 *
 * A `@smthrs/flow` flow states its pair as `payloadSchema`/`successSchema`, so
 * the comparison takes the two schemas rather than the declaration that
 * carries them.
 *
 * @since 1.0.0
 * @private
 */
export declare const declaredSchemasCompatible: (input: Schema.Top, output: Schema.Top, declared: {
    readonly input: Schema.Top;
    readonly output: Schema.Top;
}) => SchemaCompatibilityIssue | undefined;
/**
 * The name and description a pattern's `MakeOptions` may carry.
 *
 * @since 1.0.0
 * @private
 */
export interface Labeled {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
}
/**
 * @since 1.0.0
 * @private
 */
export interface Label {
    readonly name: string;
    readonly description: string | undefined;
}
/**
 * Names a pattern flow the way the decorators name theirs: the pattern kind
 * and its declared bounds, `reviewLoop(maxRounds=3)`, unless the caller
 * supplied a `name`. An `undefined` field is left out of the label.
 *
 * @since 1.0.0
 * @private
 */
export declare const label: (kind: string, fields: Readonly<Record<string, unknown>>, options: Labeled) => Label;
export {};
