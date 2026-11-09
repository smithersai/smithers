// The Set arm ignores its payload; the contract must reject it.
type Message = { readonly _tag: "Reset" } | { readonly _tag: "Set"; readonly n: number } | { readonly _tag: "Scroll"; readonly by?: number }
type Update = { readonly model: number }
declare const Message: { match<R>(message: Message, handlers: { Reset: () => R; Set: (m: { readonly n: number }) => R; Scroll: (m: { readonly by?: number }) => R }): R }

//@ verify
//@ ensures message._tag == "Set" ==> \result.model == message.n
function update(model: number, message: Message): Update {
  return Message.match<Update>(message, {
    Reset: () => ({ model: 0 }),
    Set: ({ n }) => ({ model }),
    Scroll: () => ({ model }),
  })
}
