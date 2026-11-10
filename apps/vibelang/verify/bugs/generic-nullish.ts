// A false contract: ordinary JavaScript observes undefined through the generic field.
// This must fail a real proof obligation; accepting it would expose an optional/generic modeling bug.
export interface MaybeBox<T> { readonly value: T | undefined }
//@ verify
//@ ensures \result.value == input
export function boxed<T>(input: T): MaybeBox<T> {
  return { value: input }
}
//@ verify
//@ ensures \result == false
export function absentPresence(): boolean {
  return boxed<undefined>(undefined).value !== undefined
}
