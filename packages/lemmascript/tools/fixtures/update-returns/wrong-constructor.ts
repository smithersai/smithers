// A constructed message carries its own payload.
import { Message } from "./messages";

//@ verify
//@ ensures \result == { _tag: "Opened", page: "index" }
export function opened(page: string): Message {
  return Message.Opened({ page })
}
