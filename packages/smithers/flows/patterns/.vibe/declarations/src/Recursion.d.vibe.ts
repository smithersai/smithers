/**
 * Trellis-style bounded recursive expansion declarations.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Schema from "effect/Schema";
import type { Member } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
/**
 * Parent-supplied recursion envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface Envelope {
    readonly fuel: number;
    readonly depth: number;
    readonly fanout: number;
}
/**
 * Configuration accepted by {@link recurse}.
 *
 * `child` is the only collaborator. Bounds may be narrowed by nested calls;
 * they may never exceed the parent envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface RecurseOptions<R = never> extends Envelope {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly child: Member<R>;
    readonly parent?: Envelope | undefined;
}
/**
 * The declared form of a bounded recursion.
 *
 * @category models
 * @since 0.1.0
 */
export type RecursionFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * A recursively expanded input branch.
 *
 * @category models
 * @since 0.1.0
 */
export interface Branch {
    readonly input: unknown;
    readonly children?: ReadonlyArray<Branch> | undefined;
}
/**
 * Validates and returns an envelope-bounded recursive tree flow.
 *
 * A plain input is a leaf. A `{ input, children }` branch expands recursively:
 * fuel is shared by the whole tree, depth is decremented per level, and every
 * child list is checked against fan-out before any child is admitted.
 * Very large depth and fan-out bounds build a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const recurse: <R = never>(options: RecurseOptions<R>) => RecursionFlow<R>;
