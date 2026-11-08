// LemmaScript reads TypeScript proof inputs.
interface Item { readonly value: number }
//@ verify
//@ ensures !\result
export function sameReference(item: Item): boolean {
  const copy = { ...item }
  return item === copy
}
