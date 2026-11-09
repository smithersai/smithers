// LemmaScript reads TypeScript proof fixtures; the app remains VibeLang.
interface Input { readonly kind: "empty" | "named"; readonly id?: string }
type Output = { readonly kind: "empty" } | { readonly kind: "named"; readonly id: string }
//@ verify
//@ ensures \result.kind == input.kind
//@ ensures input.kind == "named" ==> \result.id == (input.id == undefined ? "" : input.id)
export function project(input: Input): Output {
  if (input.kind === "empty") return { kind: "empty" }
  return { kind: "named", id: input.id ?? "" }
}
