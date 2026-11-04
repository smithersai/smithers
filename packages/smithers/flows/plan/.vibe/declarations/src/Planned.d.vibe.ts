/**
 * The placeholder a body sees where a step result will be.
 *
 * A flow body runs at PLAN time, so its
 * own payload is real data while every step result is a value that does not
 * exist yet. That value has a name and one rule: a planned value may be **passed** — into a payload field,
 * into a branch, into a map — and field access is allowed, because it records a
 * reference path. It may never be **computed on**.
 *
 * {@link Planned} is branded, so arithmetic is a compile error.
 * {@link make} returns a strict proxy
 * whose `Symbol.toPrimitive`, `valueOf`, `toString`, `toJSON`, and call traps
 * throw {@link module:GraphBuildError.GraphBuildError} rather than let a plan be
 * built around `NaN` or `"[object Object]"`. The lenient proxy this adapts
 * (`@smthrs/core`'s `Graph.plannedValue`) answered `toPrimitive` with a
 * readable string, which is exactly the silent-wrong-plan path this module
 * exists to close.
 *
 * JavaScript does not expose traps for `Boolean(value)` or strict identity
 * (`value === other`), so those operations cannot be refused at run time.
 * They reveal only proxy truthiness or identity and never the planned result;
 * authors must use {@link module:Node.branch} for decisions on real values.
 * Type-aware ESLint `@typescript-eslint/strict-boolean-expressions` rejects
 * planned conditions, but does not reject explicit Boolean coercion or all
 * reference comparisons. Those still require review.
 *
 * @since 0.1.0
 */
import type * as Types from "effect/Types";
/**
 * The brand carried by every planned value, and the key its reference is read
 * from. Interned with `Symbol.for` so a value that crossed a module boundary is
 * still recognised. The interned symbol is a recognition aid, not a
 * capability, so {@link reference} validates the value stored under it.
 *
 * @since 0.1.0
 * @category symbols
 * @slop
 */
export declare const TypeId: unique symbol;
/**
 * The type-level form of {@link TypeId}.
 *
 * @since 0.1.0
 * @category symbols
 * @slop
 */
export type TypeId = typeof TypeId;
/**
 * What a planned value points at: the node that will produce the result, and
 * the property path read from it. `path` is empty for the result itself.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Reference {
    readonly node: string;
    readonly path: ReadonlyArray<string>;
}
/**
 * A {@link Reference} plus the phantom type of the value it stands for, so
 * `Planned<string>` and `Planned<number>` are not interchangeable.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Identity<out T> extends Reference {
    readonly _T: Types.Covariant<T>;
}
/**
 * A step result that has not been produced yet.
 *
 * The brand rejects arithmetic and ordinary value arguments. The mapped half keeps field
 * access typed — `result.files` is a `Planned` of the field, which is what
 * makes "pass it on, never compute on it" expressible rather than merely
 * documented.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Planned<T> = {
    readonly [TypeId]: Identity<T>;
} & ([T] extends [object] ? {
    readonly [K in keyof T]: Planned<T[K]>;
} : unknown);
/**
 * Creates the strict placeholder standing for a node's result.
 *
 * Planning hands one of these to every builder that consumes an upstream
 * value — a branch arm, a continuation — and reads the {@link Reference} back
 * off whatever the builder passed it into.
 *
 * @since 0.1.0
 * @category constructors
 * @slop
 */
export declare const make: <T>(node: string) => Planned<T>;
/**
 * Reads the reference a planned value records, or `undefined` for anything
 * else. An interned symbol is a recognition aid rather than a capability, so a
 * forged carrier is accepted only when its node and path have the complete
 * reference shape. This is how a payload is scanned for the upstream results
 * it consumes.
 *
 * @since 0.1.0
 * @category accessors
 * @slop
 */
export declare const reference: (value: unknown) => Reference | undefined;
/**
 * Checks whether a value is a planned placeholder.
 *
 * @since 0.1.0
 * @category guards
 * @slop
 */
export declare const isPlanned: (value: unknown) => value is Planned<unknown>;
