/**
 * The open `JournalMetrics.tally` scopes of the current fiber.
 *
 * @since 1.0.0
 */
import { Context, Effect } from "effect";
/**
 * One open tally: the entries committed inside it so far.
 *
 * @category internal
 * @since 1.0.0
 */
export interface Accumulator {
    events: number;
}
/**
 * Every tally the current fiber runs inside, innermost last. A fiber forked
 * inside a tally inherits it, so its entries count too.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const Current: Context.Reference<readonly Accumulator[]>;
/**
 * Adds `events` committed entries to every open tally.
 *
 * @category internal
 * @since 1.0.0
 */
export declare const record: (events: number) => Effect.Effect<void>;
