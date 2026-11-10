// Swapping changes which value is on the left: claiming it kept must fail.
export interface Pair<A> { readonly left: A; readonly right: A }

//@ verify
//@ ensures \result.left == pair.left
export function swap<A>(pair: Pair<A>): Pair<A> {
  return { left: pair.right, right: pair.left }
}
