/**
 * Kanban pattern: move every item through an ordered list of columns, with a
 * concurrency bound applied inside each column.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
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
 * One card on the board.
 *
 * `id` is the identity a column call, a board row, and a failure entry all use,
 * so it must be unique across the declared items.
 *
 * @category models
 * @since 0.1.0
 */
export interface Item {
    readonly id: string;
}
/**
 * One declared column.
 *
 * @category models
 * @since 0.1.0
 */
export interface Column<R = never> {
    readonly name: string;
    readonly flow: Member<R>;
}
/**
 * The declared form of a board.
 *
 * @category models
 * @since 0.1.0
 */
export type KanbanFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly columns: ReadonlyArray<Column<R>>;
    readonly items: ReadonlyArray<Item>;
    readonly concurrency: number;
    readonly onComplete?: Member<R> | undefined;
}
/**
 * One column at runtime.
 *
 * `previous` is the value the same item produced in the preceding column, and
 * is `undefined` in the first column.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeColumn<It extends Item, Out, E, R> {
    readonly name: string;
    readonly run: (args: {
        readonly item: It;
        readonly column: string;
        readonly previous: Out | undefined;
    }) => Effect.Effect<Out, E, R>;
}
/**
 * One item that a column rejected.
 *
 * @category models
 * @since 0.1.0
 */
export interface Failure<E> {
    readonly id: string;
    readonly column: string;
    readonly error: E;
}
/**
 * The state of the board after a pass.
 *
 * `board` holds one row per item that cleared at least one column, keyed by
 * item id then column name. `completed` lists the items that cleared every
 * column, in declaration order. `failed` lists the column that rejected an item
 * and the error it raised.
 *
 * @category models
 * @since 0.1.0
 */
export interface Board<Out, E> {
    readonly board: Record<string, Record<string, Out>>;
    readonly completed: ReadonlyArray<string>;
    readonly failed: ReadonlyArray<Failure<E>>;
    readonly iterations: number;
}
/**
 * Operational callbacks for {@link run}.
 *
 * `maxIterations` is the number of passes the board runs, and defaults to one.
 * `until` stops it early, after the pass whose result satisfies the predicate,
 * and requires `maxIterations`, because a predicate that never holds would
 * otherwise run forever.
 * `run` snapshots `items`, `columns`, and every option at the call and reads
 * each item's `id` once there, so a later edit to the arrays or the option
 * object does not alter that run. The item record itself is handed to the
 * column as the caller's own object. See
 * https://smithers.sh/docs/reference/api/patterns#identity-and-ownership.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<It extends Item, Out, E, R, E2 = never, R2 = never> {
    readonly columns: ReadonlyArray<RuntimeColumn<It, Out, E, R>>;
    readonly concurrency: number;
    /**
     * Runs once after the final pass with the original items and final board.
     * A failure from this callback is the run's failure.
     */
    readonly onComplete?: ((args: {
        readonly items: ReadonlyArray<It>;
        readonly board: Board<Out, E>;
    }) => Effect.Effect<unknown, E2, R2>) | undefined;
    readonly until?: ((board: Board<Out, E>) => boolean) | undefined;
    readonly maxIterations?: number | undefined;
}
/**
 * Builds the board topology: for each column in order, one call per item,
 * batched into `Node.all` groups of `concurrency` members, with the batches
 * sequenced so the plan never admits more parallel calls than the bound.
 *
 * Each call receives `{ column, item, previous }`. `previous` refers to the
 * same item's result in the preceding column, so a built graph shows the
 * per-item chain across columns rather than a column-wide barrier of values.
 * The flow settles to the {@link Board} of its one pass, the record {@link run}
 * returns with `iterations: 1`. `onComplete` receives `{ items, board }` and
 * its own answer is discarded, as in `run`.
 * The columns themselves are sequenced: a column's first call depends on the
 * whole preceding column.
 *
 * `make` throws a `PatternError` when there are no columns, no items, a
 * duplicate item id, duplicate column name, or a concurrency that is not a
 * positive safe integer.
 *
 * `make` snapshots `columns`, `items`, and every option at the call, copying
 * each item record, so a later edit to the caller's arrays or records does
 * not change the declaration.
 *
 * A column joins its batch with {@link Quarantine.all} under the `quarantine`
 * policy, because one rejected card is not a reason to interrupt the cards
 * beside it, which is the same call {@link run} makes. A rejected card
 * settles as a {@link Quarantine.Quarantined} marker naming the item.
 *
 * A later column's call for a card is the live arm of a `Node.branch` on the
 * real set of rejected cards, so a card an earlier column rejected makes no
 * further call, exactly as in `run`. The declared call count is therefore an
 * upper bound on a pass, and the calls an executed declaration makes are the
 * calls `run` makes.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => KanbanFlow<R>;
/**
 * Moves every item through the columns in order.
 *
 * A column runs its items with `Effect.forEach` at `concurrency`, so at most
 * `concurrency` items are in flight in that column, and a column starts only
 * after the preceding column has settled for every item. An item a column
 * rejects is dropped from the board and listed in `failed`; the other items
 * keep moving. A column rejects an item by failing on the typed channel: a
 * card that throws raises a defect, which fails the pass and cancels the
 * cards beside it.
 *
 * The board runs `maxIterations` passes over the same items, one when the
 * option is absent. The old `<Kanban>` component defaulted that bound to five,
 * so a port that relied on the default must pass `maxIterations: 5`. `until`
 * stops the board early after the pass whose result satisfies the predicate. Each pass starts from an empty board, and the
 * returned board is the last pass's.
 *
 * `run` fails with a `PatternError` when two items share an id: the board is
 * keyed by item id, so a repeated id would run the same id twice and report
 * one row for both.
 *
 * @category combinators
 * @since 0.1.0
 */
export declare const run: <It extends Item, Out, E = never, R = never, E2 = never, R2 = never>(items: ReadonlyArray<It>, options: RuntimeOptions<It, Out, E, R, E2, R2>) => Effect.Effect<Board<Out, E>, PatternError | E2, R | R2>;
