export {}
interface Item { readonly text: string }
//@ verify
//@ ensures \result.length == xs.length + 1
function append(xs: ReadonlyArray<Item>): ReadonlyArray<Item> {
  return [...xs, { text: "" }].map((item) => item)
}
