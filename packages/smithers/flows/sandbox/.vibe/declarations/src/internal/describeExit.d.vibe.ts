/**
 * Renders a conformance check's unexpected outcome.
 *
 * @since 0.1.0
 */
import * as Exit from "effect/Exit";
/**
 * Describes an unexpected outcome for a violation's `actual` without leaking a
 * stack into the report.
 *
 * @category formatting
 * @since 0.1.0
 */
export declare const describeExit: (exit: Exit.Exit<unknown, unknown>) => string;
