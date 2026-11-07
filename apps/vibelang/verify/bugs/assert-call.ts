export {}
//@ verify
//@ requires n >= 0
//@ ensures \result == n
function checked(n: number): number {
  //@ assert n >= 0
  return n
}
//@ verify
//@ requires n >= 0
//@ ensures \result == n
function caller(n: number): number {
  return checked(n)
}
