/**
 * Merge-queue pattern: land a set of members in one prioritized order, at a
 * concurrency the queue owns rather than the members.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Member as Callable } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
import { PatternError } from "./PatternError.vibe";
/**
 * The priority a member gets when it does not declare one.
 *
 * It matches the priority the old `<MergeQueue>` component gave its
 * descendants, so a queue that relied on that default keeps its ordering.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const DefaultPriority = 1000;
/**
 * What a failing member does to the members behind it.
 *
 * @category models
 * @since 0.1.0
 */
export type FailurePolicy = "halt" | "quarantine";
/**
 * The declared form of a merge queue.
 *
 * @category models
 * @since 0.1.0
 */
export type MergeQueueFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * One declared member of the queue.
 *
 * @category models
 * @since 0.1.0
 */
export interface Member<R = never> {
    readonly id: string;
    readonly flow: Callable<R>;
    readonly priority?: number | undefined;
}
/**
 * Configuration for {@link make}.
 *
 * `concurrency` defaults to 1: a merge queue serializes landings unless a
 * caller widens it deliberately. Only a `quarantine` queue may widen it: a
 * `halt` queue promises that no member behind a failure lands, and a batch
 * starts its members before any of them has failed, so `halt` above
 * concurrency 1 is refused. `priority` sets the default a member without its
 * own priority receives. `members` land in the order {@link ordered}
 * resolves.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly members: ReadonlyArray<Member<R>>;
    readonly concurrency?: number | undefined;
    readonly priority?: number | undefined;
    readonly failurePolicy: FailurePolicy;
}
/**
 * One member at runtime.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeMember<I, Out, E, R> {
    readonly id: string;
    readonly priority?: number | undefined;
    readonly run: (args: {
        readonly id: string;
        readonly position: number;
        readonly input: I;
    }) => Effect.Effect<Out, E, R>;
}
/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Out, E, R> {
    readonly members: ReadonlyArray<RuntimeMember<I, Out, E, R>>;
    readonly concurrency?: number | undefined;
    readonly priority?: number | undefined;
    readonly failurePolicy: FailurePolicy;
}
/**
 * A member that landed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Landed<Out> {
    readonly id: string;
    readonly output: Out;
}
/**
 * A member the queue held back because it failed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Quarantined<E> {
    readonly id: string;
    readonly error: E;
}
/**
 * What a queue pass landed and what it held back.
 *
 * `order` is the order the queue used, so a caller can see the queue's
 * decision even when every member landed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<Out, E> {
    readonly landed: ReadonlyArray<Landed<Out>>;
    readonly quarantined: ReadonlyArray<Quarantined<E>>;
    readonly order: ReadonlyArray<string>;
}
/**
 * A member with its effective priority and queue position resolved.
 *
 * @category models
 * @since 0.1.0
 */
export interface Position<M> {
    readonly id: string;
    readonly priority: number;
    readonly position: number;
    readonly member: M;
}
/**
 * Resolves each member's effective priority and sorts the queue.
 *
 * Members land in descending priority, and members of equal priority land in
 * declaration order, so the queue's order is a function of the declaration
 * alone and never of which member became ready first.
 *
 * @category introspection
 * @since 0.1.0
 */
export declare const ordered: <M extends {
    readonly id: string;
    readonly priority?: number | undefined;
}>(members: ReadonlyArray<M>, priority: number) => ReadonlyArray<Position<M>>;
/**
 * Builds the landing topology: the members in queue order, batched into
 * `Node.all` groups of `concurrency` members, with the batches sequenced.
 *
 * At the default concurrency of 1 the queue is a plain `Node.andThen` chain,
 * with no `Node.all` at all, so the declared plan admits exactly one landing at
 * a time. Each call carries `{ id, position, input }`, so a built graph names
 * each member's place in the queue.
 *
 * A member's effective priority reaches the plan as a `Node.priority`
 * annotation rather than as call input, which is what lets the scheduler start
 * the higher-priority ready landing first. Priority stays out of key material,
 * so raising a member's number without changing the resulting order re-uses the
 * same steps rather than re-landing the queue.
 *
 * `failurePolicy` picks the topology. Under `quarantine` every member gains a
 * recovery arm settling it as MergeQueue's `Quarantined` result, so a failing
 * member neither fails the chain nor interrupts the batch beside it: the
 * queue {@link run} lands. Under `halt` the chain has no continuation past a
 * failed member, and it is always the serial chain: a halting queue is refused
 * above concurrency 1, because a batch would start a member behind a failure
 * before the failure is known.
 *
 * Every landing settles to a tagged outcome, and one final map folds them in
 * queue order into the same {@link Result} {@link run} returns:
 * `{ landed, quarantined, order }`.
 *
 * `make` throws a `PatternError` when there are no members, when two members
 * share an id, when `concurrency` is not a positive safe integer, when
 * `failurePolicy` is `halt` and `concurrency` is above 1, or when `priority`
 * is not a safe integer.
 *
 * `make` snapshots `members`, each member's `id`, `flow`, and `priority`, and
 * every option at the call, so a later edit to the caller's array, records,
 * or option object does not change the declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => MergeQueueFlow<R>;
/**
 * Lands the members in queue order at the queue's concurrency.
 *
 * At the default concurrency of 1 the members land strictly one at a time, in
 * descending priority and then declaration order.
 * Members receive `{ id, position, input }`, as in {@link make}. Priority
 * controls queue order and stays out of member payloads.
 *
 * Under `failurePolicy: "halt"` a failing member fails the queue and no member
 * behind it lands, which is why `halt` runs only at concurrency 1: a wider
 * queue would have started the next member before the failure was known.
 * `run` fails with a `PatternError` for `halt` above concurrency 1, before
 * any member starts. Under `"quarantine"` the failure is recorded, the member
 * does not land, and the members behind it still do. A quarantined entry is
 * `{ id, error }`, untagged, because `landed` and `quarantined` are separate
 * arrays.
 *
 * Both policies read the typed failure channel. A member that throws raises a
 * defect, which fails the queue under either policy and cancels the landings
 * still in flight.
 *
 * `run` snapshots `members`, each member's `id`, `priority`, and `run`, and
 * every option at the call, so a later edit to the caller's array, records,
 * or option object does not alter that run.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, Out, E = never, R = never>(input: I, options: RuntimeOptions<I, Out, E, R>) => Effect.Effect<Result<Out, E>, E | PatternError, R>;
