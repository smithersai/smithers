// A spread evaluates each operand once, the base first, even when the override replaces every field.
type Pair = { readonly a: number; readonly b: number }

//@ verify
//@ requires k > 0
//@ ensures \result.a == k && \result.b == k
function positive(k: number): Pair { return { a: k, b: k } }

//@ verify
//@ ensures \result.a == 1 && \result.b == 2
function constant(k: number): Pair { return { a: 1, b: 2 } }

/** The base call runs, so its precondition is owed, though the override replaces both of its fields. */
//@ verify
//@ requires k > 0
//@ ensures \result.a == 1 && \result.b == 2
function replaced(k: number): Pair { return { ...positive(k), ...constant(k) } }

/** A loop makes this a method: an operand calling it is one statement, not a call per field. */
//@ verify
//@ requires n >= 0
//@ ensures \result.a == n && \result.b == n
function counted(n: number): Pair {
  let i = 0
  //@ invariant 0 <= i && i <= n
  while (i < n) { i = i + 1 }
  return { a: n, b: n }
}

//@ verify
//@ requires n > 0
//@ ensures \result.a == n && \result.b == n
function recounted(n: number): Pair { return { ...positive(n), ...counted(n) } }
