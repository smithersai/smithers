// Not exhaustive at the type level: must never be read as a tagged match.
type Message = { readonly _tag: "Reset" } | { readonly _tag: "Set"; readonly n: number }
declare const Message: { match(message: Message, handlers: { Reset: () => number }): number }

//@ verify
//@ ensures \result == 0
function update(message: Message): number {
  return Message.match(message, { Reset: () => 0 })
}
