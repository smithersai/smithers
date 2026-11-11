// The witness fixture with a false claim: the parity flips. The witness must not let it prove.

export interface Piece { readonly code: boolean; readonly text: string }

//@ verify
//@ ensures forall(i, 0 <= i && i < \result.length ==> exists(k, 0 <= k && k < parts.length && \result[i].text == parts[k] && \result[i].code == (k % 2 == 0)))
export function pieces(parts: ReadonlyArray<string>): ReadonlyArray<Piece> {
  let out: Piece[] = []
  for (let j = 0; j < parts.length; j++) {
    //@ invariant 0 <= j && j <= parts.length
    //@ invariant forall(i, 0 <= i && i < out.length ==> exists(k, 0 <= k && k < j && out[i].text == parts[k] && out[i].code == (k % 2 == 1)))
    if (parts[j]! !== "") {
      const prev = out
      out = [...prev, { code: j % 2 === 1, text: parts[j]! }]
      //@ assert forall(i, 0 <= i && i < prev.length ==> out[i] == prev[i])
      //@ assert out[prev.length].text == parts[j] && out[prev.length].code == (j % 2 == 1)
    }
  }
  //@ assert forall(i, 0 <= i && i < out.length ==> exists(k, 0 <= k && k < parts.length && out[i].text == parts[k] && out[i].code == (k % 2 == 0))) by exists(k, 0 <= k && k < parts.length && out[i].text == parts[k] && out[i].code == (k % 2 == 1))
  return out
}

//@ verify
//@ requires forall(i, 0 <= i && i < a.length ==> exists(k, 0 <= k && k < parts.length && a[i] == parts[k]))
//@ ensures forall(i, 0 <= i && i < \result.length ==> exists(k, 0 <= k && k < parts.length && \result[i] == parts[k]))
export function copy(parts: ReadonlyArray<number>, a: ReadonlyArray<number>): ReadonlyArray<number> {
  const out = a
  //@ assert forall(i, 0 <= i && i < out.length ==> exists(k, 0 <= k && k < parts.length && out[i] == parts[k])) by exists(k, 0 <= k && k < parts.length && a[i] == parts[k])
  return out
}

// A caller reasons from copy's named postcondition through its own ground terms.
//@ verify
//@ requires parts.length == 1 && a.length == 1 && a[0] == parts[0]
//@ ensures \result.length == 1 ==> \result[0] == parts[0]
export function copyOne(parts: ReadonlyArray<number>, a: ReadonlyArray<number>): ReadonlyArray<number> {
  const out = copy(parts, a)
  //@ assert out.length == 1 ==> out[0] == parts[0]
  return out
}
