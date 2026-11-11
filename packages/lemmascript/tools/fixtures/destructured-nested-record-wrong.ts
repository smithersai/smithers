// Destructuring a value of an anonymous record type synthesizes a record for it and one for each nested anonymous
// record. Every one of them is declared, so the rest and the original fields resolve. Wrong twin: claims the other nested field.
//@ verify
//@ ensures \result == model.k + model.inner.m
export function total(model: { readonly inner: { readonly n: number; readonly m: number }; readonly k: number }): number {
  const { k, ...rest } = model
  return k + rest.inner.n
}

// An inline record parameter is a record of its own (lemmascript-inline-record-parameter).
//@ verify
//@ ensures \result == box.a
export function first(box: { readonly a: number; readonly b: number }): number {
  return box.a
}
