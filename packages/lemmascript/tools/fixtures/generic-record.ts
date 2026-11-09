// A generic record (interface or object type alias) keeps its type parameter.
export interface Page<C> { readonly seq: number; readonly items: ReadonlyArray<C> }
export type Pair<A> = { readonly left: A; readonly right: A }

//@ verify
//@ ensures \result.seq == page.seq + 1 && \result.items == page.items
export function next<C>(page: Page<C>): Page<C> {
  return { seq: page.seq + 1, items: page.items }
}

//@ verify
//@ ensures \result.left == pair.right && \result.right == pair.left
export function swap<A>(pair: Pair<A>): Pair<A> {
  return { left: pair.right, right: pair.left }
}

//@ verify
//@ ensures \result.length == page.items.length + 1 && \result[page.items.length] == item
export function appended<C>(page: Page<C>, item: C): ReadonlyArray<C> {
  return [...page.items, item]
}
