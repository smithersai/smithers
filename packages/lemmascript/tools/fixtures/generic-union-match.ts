export type Choice<T> = { readonly _tag: "Value"; readonly value: T } | { readonly _tag: "Empty" }
//@ verify
//@ ensures choice._tag == "Value" ==> \result == choice.value
//@ ensures choice._tag == "Empty" ==> \result == fallback
export function selected<U>(choice: Choice<U>, fallback: U): U {
  if (choice._tag === "Value") return choice.value
  return fallback
}
//@ verify
//@ ensures \result.length == 1
//@ ensures choice._tag == "Value" ==> \result[0] == choice.value
//@ ensures choice._tag == "Empty" ==> \result[0] == fallback
export function listed<U>(choice: Choice<U>, fallback: U): ReadonlyArray<U> {
  let value = fallback
  if (choice._tag === "Value") value = choice.value
  return [value]
}
