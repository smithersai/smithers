// The Scroll arm defaults to 2, not the 1 its contract states; the proof must fail on that obligation.
declare const Schema: any
declare function defineMessageUnion(tags: object): any
type Size = "s" | "m"

const Message = defineMessageUnion({
  Reset: {},
  Set: { n: Schema.Number },
  Scroll: { by: Schema.optionalKey(Schema.Number) },
  Pick: { size: Schema.Literals(["s", "m"]) },
  Named: { size: Size, label: Schema.String, on: Schema.Boolean },
  Many: { items: Schema.Array(Schema.Number) },
})
type Message = typeof Message.Type
type Update = { readonly model: number }

//@ verify
//@ ensures message._tag == "Reset" ==> \result.model == 0
//@ ensures message._tag == "Set" ==> \result.model == message.n
//@ ensures message._tag == "Scroll" ==> (message.by !== undefined ==> \result.model == model + message.by)
//@ ensures message._tag == "Scroll" ==> (message.by === undefined ==> \result.model == model + 1)
//@ ensures message._tag == "Pick" ==> \result.model == (message.size == "s" ? 1 : 2)
//@ ensures message._tag == "Named" ==> (message.on ==> \result.model == (message.size == "s" ? 1 : 2))
//@ ensures message._tag == "Named" ==> (!message.on ==> \result.model == model)
//@ ensures message._tag == "Many" ==> \result.model == message.items.length
function update(model: number, message: Message): Update {
  return Message.match<Update>(message, {
    Reset: () => ({ model: 0 }),
    Set: ({ n }) => ({ model: n }),
    Scroll: ({ by = 2 }) => ({ model: model + by }),
    Pick: ({ size }) => ({ model: size === "s" ? 1 : 2 }),
    Named: ({ size, on }) => ({ model: on ? (size === "s" ? 1 : 2) : model }),
    Many: ({ items }) => ({ model: items.length }),
  })
}
