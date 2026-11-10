// LemmaScript reads TypeScript fixtures; the nullable nested record relation is exact.
interface Item { readonly step: number }
type Choice = { readonly kind: "none"; readonly value: null } | { readonly kind: "some"; readonly value: Item }
//@ verify
//@ ensures item == null ==> \result.kind == "none" && \result.value == null
//@ ensures item != null ==> \result.kind == "some" && \result.value == item
export function choice(item: Item | null): Choice {
  if (item === null) return { kind: "none", value: null }
  return { kind: "some", value: item }
}
