// A record type named by an alias of an anonymous type (`type Model = typeof Model.Type`, as a schema declares it)
// keeps its name as a return type, so the result compares with a parameter of the same type.
declare const Shape: { readonly Type: { readonly count: number; readonly label: string } }
export type Counter = typeof Shape.Type

//@ verify
//@ ensures !go ==> \result == counter
//@ ensures go ==> \result.count == counter.count + 1 && \result.label == counter.label
export function bump(counter: Counter, go: boolean): Counter {
  return go ? { ...counter, count: counter.count + 1 } : counter
}
