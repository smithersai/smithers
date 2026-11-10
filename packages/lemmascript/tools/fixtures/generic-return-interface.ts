export interface Wrapped<T> { readonly value: T }
//@ verify
//@ ensures \result.value == value
export function wrap<T>(value: T): Wrapped<T> { return { value } }
