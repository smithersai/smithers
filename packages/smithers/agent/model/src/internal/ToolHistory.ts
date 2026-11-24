/**
 * Provider transcript tool-call tracking.
 * @since 1.0.0
 */

import type { AssistantMessage } from "../ModelRequest.ts"

/** Record calls omitted with an assistant turn, allowing a later valid turn to reuse its id.
 * @category helpers
 * @since 1.0.0
 */
export const trackToolCalls = (dropped: Set<string>, message: AssistantMessage): void => {
  for (const part of message.content) {
    if (part.type !== "tool-call") continue
    if (message.stopReason === "aborted" || message.stopReason === "error") dropped.add(part.id)
    else dropped.delete(part.id)
  }
}
