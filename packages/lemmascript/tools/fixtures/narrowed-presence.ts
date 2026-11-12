// Inside the arm where an optional is present, a presence check on it is a constant and a loop's measure reads it.

export function keyNeedsOp(op: string | undefined, key: string | undefined): boolean {
  //@ ensures op !== undefined && key === undefined ==> \result
  //@ ensures op === undefined ==> !\result
  if (op === undefined || key === undefined) return op !== undefined
  return op.length > key.length
}

export function counted(text: string | undefined): number {
  //@ ensures text === undefined ==> \result === 0
  //@ ensures text !== undefined ==> \result === text.length
  if (text === undefined) return 0
  let i = 0
  while (i < text.length) {
    //@ invariant 0 <= i && i <= text.length
    //@ decreases text.length - i
    i = i + 1
  }
  return i
}
