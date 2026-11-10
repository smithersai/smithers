//@ backend dafny

export function answer(): number {
  //@ verify
  //@ ensures \result === 42
  return 42;
}
