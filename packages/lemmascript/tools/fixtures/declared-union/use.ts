// A tagged union read from a project declaration file, through a type-only import.
import type { Message } from "./messages.js"

//@ verify
//@ ensures message._tag == "Reset" ==> \result == 0
//@ ensures message._tag == "Set" ==> \result == message.n
export function value(message: Message): number {
  if (message._tag === "Reset") return 0
  return message.n
}
