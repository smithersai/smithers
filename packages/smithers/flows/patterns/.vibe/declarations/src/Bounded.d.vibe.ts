/**
 * Bounded fan-out: a fixed set of members run at most `concurrency` at a time,
 * highest priority first.
 *
 * `Node.all` joins members without a width bound, which is the right default
 * for a handful of independent calls and the wrong one for fifty. {@link all}
 * keeps the same named-record shape and adds the bound as static topology: one
 * `Node.all` per batch, batches sequenced. {@link run} is the Effect form of
 * the same contract.
 *
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Node from "@smthrs/plan/Node";
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
import { PatternError } from "./PatternError.vibe";
/**
 * Configuration for {@link all}.
 *
 * `priority` is the container's default: a member that carries its own
 * `Node.priority` keeps it, and every other member inherits this one.
 *
 * @category models
 * @since 0.1.0
 */
export interface AllOptions {
    readonly concurrency: number;
    readonly priority?: number | undefined;
}
/**
 * Configuration for {@link run}.
 *
 * `priorities` holds per-member priorities by name; `priority` is the default
 * for every member that names none.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions {
    readonly concurrency: number;
    readonly priority?: number | undefined;
    readonly priorities?: Readonly<Record<string, number>> | undefined;
}
/**
 * Joins a record of members with a static width bound.
 *
 * Members are split into batches of `concurrency` in priority order and the
 * batches are sequenced, so the plan shows exactly how many calls can be in
 * flight. The result is one record carrying every member's value under its
 * declared name.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const all: <const Nodes extends Readonly<Record<string, Node.Any>>>(members: Nodes, options: AllOptions) => Node.Node<Types.Simplify<{ readonly [K in keyof Nodes]: Node.Success<Nodes[K]>; }>, Node.Error<Nodes[keyof Nodes]>, Node.Services<Nodes[keyof Nodes]>>;
/**
 * Runs a record of effects at most `concurrency` at a time, starting the
 * highest priority member first.
 *
 * Failure and interruption follow `Effect.forEach`: the first failure
 * interrupts the members still in flight. Use `Quarantine.run` when siblings
 * must finish instead.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <A, E, R>(members: Readonly<Record<string, Effect.Effect<A, E, R>>>, options: RuntimeOptions) => Effect.Effect<Readonly<Record<string, A>>, E | PatternError, R>;
