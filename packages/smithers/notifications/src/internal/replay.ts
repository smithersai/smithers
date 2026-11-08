/**
 * The one replay rule for an admission record, shared by the queue's fold and
 * the journal projection so the two read the same history to the same state.
 *
 * @private
 * @since 1.0.0
 */

import type * as NotificationEvent from "../NotificationEvent.vibe"
import * as NotificationState from "../NotificationState.ts"

/**
 * Applies one committed admission record to the state so far.
 *
 * A versioned record whose id is still pending is an edit: it replaces that
 * item in place and keeps its original sequence, so the edit is delivered at
 * the cutoff the first version was admitted under. Every other record applies
 * the decision it committed.
 *
 * @throws {never}
 * @private
 * @since 1.0.0
 */
export const applyAdmitted = (
  state: NotificationState.State,
  event: NotificationEvent.Admitted,
  seq: number
): NotificationState.State => {
  if (event.version !== undefined && state.items.some((item) => item.notification.id === event.notification.id)) {
    return Object.freeze({
      ...state,
      items: Object.freeze(state.items.map((item) =>
        item.notification.id === event.notification.id
          ? Object.freeze({ notification: event.notification, seq: item.seq })
          : item
      ))
    })
  }
  return NotificationState.applyAdmission(state, event.notification, seq, event.decision)
}
