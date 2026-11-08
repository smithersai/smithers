// LemmaScript reads TypeScript proof inputs.
interface Item { readonly rank: number; readonly id: string }
//@ verify
//@ ensures \result.length == items.length
//@ ensures forall(i, 0 <= i && i < \result.length ==> items.includes(\result[i]))
//@ ensures forall(i, 0 <= i && i < items.length ==> \result.includes(items[i]))
//@ ensures forall(i, 0 < i && i < \result.length ==> \result[i - 1].rank <= \result[i].rank)
export function sorted(items: ReadonlyArray<Item>): ReadonlyArray<Item> {
  const result = [...items].sort((a, b) => a.rank - b.rank)
  //@ assert forall(i, 0 <= i && i < result.length ==> items.includes(result[i]))
  //@ assert forall(i, 0 <= i && i < items.length ==> result.includes(items[i]))
  return result
}
