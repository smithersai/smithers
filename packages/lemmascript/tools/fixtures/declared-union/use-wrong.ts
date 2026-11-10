// The Set case returns n + 1 against its contract; the proof must fail on that obligation.
import type { Message } from "./messages.js"

//@ verify
//@ ensures message._tag == "Reset" ==> \result == 0
//@ ensures message._tag == "Set" ==> \result == message.n
export function value(message: Message): number {
  if (message._tag === "Reset") return 0
  return message.n + 1
}
