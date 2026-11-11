/**
 * When the drive running a step stops starting steps.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"

/**
 * When the drive running this step stops starting steps, in epoch
 * milliseconds on the effect `Clock`: the end of its host's budget (a hosted
 * engine's `budgetMs`), or `undefined` when its host sets none. A step that
 * waits on work outside its run, as `ExternalJob`'s `run` does, waits no later
 * than this, so it never holds a drive past its budget; work still going then
 * goes on without the drive.
 *
 * @category references
 * @since 1.0.0
 */
export const DriveDeadline = Context.Reference<number | undefined>("@smthrs/flow/FlowRuntime/DriveDeadline", {
  defaultValue: () => undefined
})
