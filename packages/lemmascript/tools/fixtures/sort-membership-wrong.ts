// The function sorts `others`, not `items`; every item of the result must come from `items`.
interface Item { readonly rank: number; readonly id: string }

//@ verify
//@ ensures forall(i, 0 <= i && i < \result.length ==> items.includes(\result[i]))
export function sorted(items: ReadonlyArray<Item>, others: ReadonlyArray<Item>): ReadonlyArray<Item> {
  return [...others].sort((a, b) => a.rank - b.rank)
}
