// An exhaustive tagged-message handler table in return position.
type Message = { readonly _tag: "Reset" } | { readonly _tag: "Set"; readonly n: number } | { readonly _tag: "Scroll"; readonly by?: number }
type Update = { readonly model: number }
declare const Message: { match<R>(message: Message, handlers: { Reset: () => R; Set: (m: { readonly n: number }) => R; Scroll: (m: { readonly by?: number }) => R }): R }

//@ verify
//@ ensures message._tag == "Reset" ==> \result.model == 0
//@ ensures message._tag == "Set" ==> \result.model == message.n
//@ ensures message._tag == "Scroll" ==> (message.by !== undefined ==> \result.model == model + message.by)
//@ ensures message._tag == "Scroll" ==> (message.by === undefined ==> \result.model == model + 1)
function update(model: number, message: Message): Update {
  return Message.match<Update>(message, {
    Reset: () => ({ model: 0 }),
    Set: ({ n }) => { const v = n; return { model: v } },
    Scroll: ({ by = 1 }) => ({ model: model + by }),
  })
}
