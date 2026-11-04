/**
 * A deterministic panel deliberation pattern.
 *
 * A panel asks several flows the same question under different instructions
 * and hands one moderator every answer. {@link make} declares that topology,
 * {@link run} performs it.
 *
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Member } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
import { PatternError } from "./PatternError.vibe";
/**
 * Configuration for {@link make}.
 *
 * Panelists are held in a record so their declared keys are stable shard
 * identities. The moderator receives `{ input, opinions }`, where `opinions`
 * preserves those keys and declaration order.
 *
 * A panelist named in `roles` is called with `{ input, role }` instead of the
 * bare input, and the role is part of that call's identity. `concurrency`
 * bounds how many panelists the declaration lets run at once; without it the
 * panel fans out in one join.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly panelists: Readonly<Record<string, Member<R>>>;
    readonly moderator: Member<R>;
    readonly roles?: Readonly<Record<string, string>> | undefined;
    readonly concurrency?: number | undefined;
}
/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, A, E, R, B, E2, R2> {
    readonly panelists: Readonly<Record<string, (input: I) => Effect.Effect<A, E, R>>>;
    readonly moderator: (input: {
        readonly input: I;
        readonly opinions: Readonly<Record<string, A>>;
    }) => Effect.Effect<B, E2, R2>;
    readonly concurrency?: number | undefined;
}
/**
 * The declared form of a panel.
 *
 * @category models
 * @since 0.1.0
 */
export type PanelFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Fans out every independent panelist call and then invokes the moderator.
 *
 * Without `concurrency`, `Node.all` gives child work structured-concurrency
 * ownership: interruption of the parent interrupts every outstanding
 * panelist, and one panelist failure fails the whole join. With
 * `concurrency`, the same members are batched by `Bounded.all`, so the plan
 * states how many panelists can be in flight.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => PanelFlow<R>;
/**
 * Runs every panelist against the same input and hands the moderator one
 * record of opinions keyed by panelist name.
 *
 * `concurrency` bounds how many panelists run at once; without it they all
 * start together. Keys follow declaration order whatever order the panelists
 * settle in, so a moderator never sees a race in its payload.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <I, A, E, R, B, E2, R2>(input: I, options: RuntimeOptions<I, A, E, R, B, E2, R2>) => Effect.Effect<B, E | E2 | PatternError, R | R2>;
