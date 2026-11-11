// A match returning method results stays inside its calling and conditional scope.
type Message = { readonly _tag: "Keep" } | { readonly _tag: "More"; readonly n: number };
declare const Message: { match<R>(message: Message, handlers: { Keep: () => R; More: (m: { n: number }) => R }): R };

//@ verify
//@ requires n > 0
//@ ensures \result == n + 1
function positive(n: number): number { let value = n; value = value + 1; return value; }

//@ verify
//@ requires enabled && message._tag == "More" ==> message.n > 0
//@ ensures !enabled ==> \result == 0
//@ ensures enabled && message._tag == "Keep" ==> \result == 7
//@ ensures enabled && message._tag == "More" ==> \result == message.n + 1
function conditional(enabled: boolean, message: Message): number {
  return enabled ? Message.match(message, { Keep: () => 7, More: ({ n }) => 0 }) : 0;
}

//@ verify
//@ requires enabled && message._tag == "More" ==> message.n > 0
//@ ensures \result == enabled
function conjunction(enabled: boolean, message: Message): boolean {
  return enabled && Message.match(message, { Keep: () => true, More: ({ n }) => positive(n) > 0 });
}

//@ verify
//@ requires !enabled && message._tag == "More" ==> message.n > 0
//@ ensures \result
function disjunction(enabled: boolean, message: Message): boolean {
  return enabled || Message.match(message, { Keep: () => true, More: ({ n }) => positive(n) > 0 });
}

//@ verify
//@ requires message !== undefined && message._tag == "More" ==> message.n > 0
//@ ensures message === undefined ==> \result == 0
//@ ensures message !== undefined && message._tag == "Keep" ==> \result == 7
//@ ensures message !== undefined && message._tag == "More" ==> \result == message.n + 1
function optional(message: Message | undefined): number {
  return message === undefined ? 0 : Message.match(message, { Keep: () => 7, More: ({ n }) => positive(n) });
}
