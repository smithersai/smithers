// A tagged match may be a wrapped argument, a local initializer, or an arithmetic operand.
type Message = { readonly _tag: "Reset" } | { readonly _tag: "Set"; readonly n: number } | { readonly _tag: "Scroll"; readonly by?: number };
type Update = { readonly model: number };
declare const Message: { match<R>(message: Message, handlers: { Reset: () => R; Set: (m: { n: number }) => R; Scroll: (m: { by?: number }) => R }): R };

//@ verify
//@ ensures \result.model == value.model + 1
function wrapped(value: Update): Update { return { model: value.model + 1 }; }

//@ verify
//@ ensures message._tag == "Reset" ==> \result.model == 1
//@ ensures message._tag == "Set" ==> \result.model == message.n + 1
//@ ensures message._tag == "Scroll" && message.by === undefined ==> \result.model == model + 2
//@ ensures message._tag == "Scroll" && message.by !== undefined ==> \result.model == model + message.by + 1
function update(model: number, message: Message): Update {
  const next = wrapped(Message.match<Update>(message, {
    Reset: () => ({ model: 0 }),
    Set: ({ n }) => { const values = [n]; return { model: values[0]! }; },
    Scroll: ({ by = 1 }) => ({ model: model + by }),
  }));
  return next;
}

//@ verify
//@ ensures message._tag == "Set" ==> \result == message.n + 2
function added(message: Message): number {
  return 2 + Message.match(message, { Reset: () => 0, Set: ({ n }) => n, Scroll: () => 1 });
}


//@ verify
//@ ensures \result == y - x
function swapped(x: number, y: number): number {
  return ((x: number, y: number) => x - y)(y, x);
}
