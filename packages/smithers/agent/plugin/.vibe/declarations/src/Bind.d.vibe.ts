/**
 * The closed binding grammar a view event's `args` and a keybinding's
 * `fields` are written in, and the host's filling of them.
 *
 * A value is a JSON literal, or a string reference rooted at `$item` (the
 * selected row of the view's `reads`), `$event` (the event's payload) or
 * `$key` (the key pressed: `$key.index` is 0 for `1` … 8 for `9`), followed by
 * at most four `.<name>`, `[<n>]` or `[$event.<name>]` segments, as in
 * `$item.options[$event.index]`. A string not starting with `$` is a literal;
 * objects and arrays are walked. Nothing else is evaluated.
 *
 * @since 1.1.0
 */
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { Refusal } from "./Contribution.vibe";
/**
 * Where a reference starts.
 *
 * @category models
 * @since 1.1.0
 */
export type Root = "item" | "event" | "key";
/**
 * One step of a reference: a field name, an array index, or an index read
 * from the event's payload.
 *
 * @category models
 * @since 1.1.0
 */
export type Segment = string | number | {
    readonly event: string;
};
/**
 * A parsed reference, and where in the args it was written.
 *
 * @category models
 * @since 1.1.0
 */
export interface Reference {
    readonly root: Root;
    readonly path: ReadonlyArray<Segment>;
    /** The arg it was written at, as `value.note`. */
    readonly at: string;
}
/**
 * The values a binding is filled from.
 *
 * @category models
 * @since 1.1.0
 */
export interface Scope {
    readonly item: unknown;
    readonly event: unknown;
    readonly key?: {
        readonly index: number;
    } | undefined;
}
/**
 * The most segments after a reference's root.
 *
 * @category limits
 * @since 1.1.0
 */
export declare const maximumSegments = 4;
/**
 * Every reference a binding makes, in the order written. A string starting
 * with `$` outside the grammar refuses `invalid`, its path `at` followed by
 * the arg it was written at.
 *
 * @category parsing
 * @since 1.1.0
 */
export declare const references: (args: {
    readonly [key: string]: Schema.Json;
}, at?: string) => Result.Result<ReadonlyArray<Reference>, Refusal>;
/**
 * Fills a binding from a scope: literals as written, references by value. A
 * reference that reaches no value fails, naming the reference.
 *
 * @category binding
 * @since 1.1.0
 */
export declare const bind: (args: {
    readonly [key: string]: Schema.Json;
}, scope: Scope) => Result.Result<{
    readonly [key: string]: unknown;
}, string>;
