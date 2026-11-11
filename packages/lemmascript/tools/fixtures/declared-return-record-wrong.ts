// A bumped counter is not the counter it started from.
declare const Shape: { readonly Type: { readonly count: number; readonly label: string } }
export type Counter = typeof Shape.Type

//@ verify
//@ ensures \result == counter
export function bump(counter: Counter, go: boolean): Counter {
  return go ? { ...counter, count: counter.count + 1 } : counter
}
