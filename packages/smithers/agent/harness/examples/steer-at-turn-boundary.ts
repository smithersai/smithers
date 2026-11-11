/**
 * Queue an operator message, a seat change and a followup, then drain the queue
 * at a turn's close boundary. Items admitted after the cutoff and `queue`
 * followups stay for a later boundary.
 */
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Steering from "../src/Steering.vibe"

/** Drains a four-item queue at cutoff 10 and reports what each side holds. */
export const steerAtTurnBoundary = (): {
  readonly inserts: ReadonlyArray<string>
  readonly seatChanges: ReadonlyArray<string>
  readonly remaining: ReadonlyArray<string>
  readonly original: number
} => {
  let queue = Steering.empty()
  queue = Steering.enqueue(queue, {
    _tag: "Insert",
    delivery: "steer",
    admittedAt: 5,
    message: ModelRequest.Message.user("Prefer the smaller patch.")
  })
  queue = Steering.enqueue(queue, { _tag: "SeatChange", delivery: "steer", admittedAt: 8, seat: "fast" })
  // A followup waits until the run would otherwise go idle.
  queue = Steering.enqueue(queue, {
    _tag: "Insert",
    delivery: "queue",
    admittedAt: 9,
    message: ModelRequest.Message.user("Then update the changelog.")
  })
  // Admitted after the turn's cutoff, so it belongs to the next turn.
  queue = Steering.enqueue(queue, {
    _tag: "Insert",
    delivery: "steer",
    admittedAt: 12,
    message: ModelRequest.Message.user("Also run the linter.")
  })
  const drain = Steering.drainAtClose(queue, 10)
  const text = (message: ModelRequest.Message): string =>
    message.role === "user" ? message.content.map((part) => part.text).join("") : message.role
  return {
    inserts: drain.inserts.map(text),
    seatChanges: drain.seatChanges.map((change) => change._tag === "SeatChange" ? change.seat : change.thinking),
    remaining: drain.remaining.items.map((item) => item._tag === "Insert" ? text(item.message) : item._tag),
    // Draining never mutates the queue it read.
    original: queue.items.length
  }
}
