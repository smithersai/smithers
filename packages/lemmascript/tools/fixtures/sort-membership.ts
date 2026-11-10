// A sorted copy keeps exactly the input's items: membership in both directions follows from the sort's permutation.
interface Item { readonly rank: number; readonly id: string }

//@ verify
//@ ensures \result.length == items.length
//@ ensures forall(i, 0 <= i && i < \result.length ==> items.includes(\result[i]))
//@ ensures forall(i, 0 <= i && i < items.length ==> \result.includes(items[i]))
//@ ensures forall(i, 0 < i && i < \result.length ==> \result[i - 1].rank <= \result[i].rank)
export function sorted(items: ReadonlyArray<Item>): ReadonlyArray<Item> {
  return [...items].sort((a, b) => a.rank - b.rank)
}

//@ verify
//@ ensures forall(i, 0 <= i && i < \result.length ==> items.includes(\result[i]))
//@ ensures forall(i, 0 <= i && i < items.length ==> \result.includes(items[i]))
export function plainSorted(items: ReadonlyArray<number>): ReadonlyArray<number> {
  return [...items].sort()
}
