/**
 * Wall-clock cron occurrences in a time zone, daylight saving included.
 *
 * A cron expression names wall-clock times. Searching those times with a UTC
 * cron is exact, so the zone only matters when a wall time is turned into an
 * instant:
 *
 * - A wall time that exists once is that instant.
 * - A wall time inside a spring-forward gap fires at the instant it would have
 *   had on the old offset: a daily 02:30 fires at 03:30 daylight time.
 * - A wall time repeated by fall back fires once, at its first instant. An
 *   expression whose hour field is every hour fires in both passes instead, so
 *   an hourly or minutely schedule keeps running through the repeated hour.
 *
 * Instants are whole seconds in UTC, so millisecond zeroing never reads the
 * host's zone.
 *
 * @since 1.0.0-rc.1
 */
import * as EffectCron from "effect/Cron";
/** The zone's wall clock minus UTC at an instant, in milliseconds. */
type Offset = (instant: number) => number;
/**
 * A cron compiled for wall-clock search.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export interface WallCron {
    readonly wall: EffectCron.Cron;
    readonly offset: Offset;
    readonly everyHour: boolean;
}
/**
 * Compiles an Effect cron once: its fields as a UTC cron over wall-clock
 * times, and its zone's offset.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export declare const compile: (cron: EffectCron.Cron) => WallCron;
/**
 * The first occurrence strictly after `from`. Throws when the wall-clock search
 * is exhausted.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export declare const next: (cron: WallCron, from: number) => number;
/**
 * The latest occurrence at or before `at`, in whole seconds. Throws when the
 * wall-clock search is exhausted.
 *
 * @private
 * @since 1.0.0-rc.1
 */
export declare const previousAtOrBefore: (cron: WallCron, at: number) => number;
export {};
