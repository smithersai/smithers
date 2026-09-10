/**
 * The segments a compaction may replace.
 *
 * A window's system and instruction segments are what the next turn is still
 * addressed to, so only the conversational kinds are eligible. `ContextWindow`
 * selects the prefix and `Compaction` declares one against the same selection;
 * two spellings of this filter that drifted would let a declared prefix name
 * segments the window would never replace.
 *
 * @since 1.0.0-rc.0
 * @private
 */
import type * as ContextWindow from "../ContextWindow.ts"

/**
 * The transcript, summary and steering segments of a window, in order.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const compactable = (
  segments: ReadonlyArray<ContextWindow.Segment>
): ReadonlyArray<ContextWindow.Segment> =>
  segments.filter((segment) =>
    segment.kind === "transcript" || segment.kind === "summary" || segment.kind === "steering"
  )
