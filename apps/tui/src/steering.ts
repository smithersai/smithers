/**
 * Messages typed while a turn runs, delivered at the next cell boundary.
 *
 * This is the harness's own steering queue (`@smthrs/harness/Steering`):
 * a message sent with Enter mid-turn reaches the model before its next cell,
 * the way pi steers between tool calls. A drain is idempotent per boundary,
 * as the `Source` contract requires.
 */
import * as Steering from "@smthrs/harness/Steering"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect } from "effect"

export interface Queue {
  readonly source: Steering.Source
  readonly steer: (text: string) => void
  /** Removes and returns every message no boundary has delivered yet. */
  readonly take: () => ReadonlyArray<string>
}

const text = (item: Steering.Item): string =>
  item._tag === "Insert"
    ? item.message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    : ""

export const make = (): Queue => {
  let queue = Steering.empty()
  const drained = new Map<string, Steering.Drain>()
  return {
    steer: (text) => {
      queue = Steering.enqueue(queue, {
        _tag: "Insert",
        delivery: "steer",
        admittedAt: Date.now(),
        message: new ModelRequest.UserMessage({ role: "user", content: [ModelRequest.TextPart.make({ text })] })
      })
    },
    take: () => {
      const texts = queue.items.map(text).filter((entry) => entry !== "")
      queue = Steering.empty()
      return texts
    },
    source: Steering.make({
      read: () => Effect.sync(() => queue),
      drain: (input) =>
        Effect.sync(() => {
          const seen = drained.get(input.boundary)
          if (seen !== undefined) return { ...seen, duplicate: true }
          const drain = { ...Steering.drainAtClose(queue, Date.now()), duplicate: false }
          queue = drain.remaining
          drained.set(input.boundary, drain)
          return drain
        })
    })
  }
}
