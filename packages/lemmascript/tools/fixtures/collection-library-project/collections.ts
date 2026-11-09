//@ backend dafny

export function positiveNumbers(): number[] {
  //@ verify
  //@ ensures \result.length === 2 && \result[0] === 1 && \result[1] === 2
  return [-1, 1, 2].filter(value => value > 0);
}

export function everyNumberIsPositive(): boolean {
  //@ verify
  //@ ensures \result === true
  return [1, 2, 3].every(value => value > 0);
}

export function sumNumbers(): number {
  //@ verify
  //@ ensures \result === 6
  return [1, 2, 3].reduce((total, value) => total + value, 0);
}

export function nonemptyStrings(): string[] {
  //@ verify
  //@ ensures \result.length === 2 && \result[0] === "a" && \result[1] === "bc"
  return ["a", "", "bc"].filter(value => value.length > 0);
}

export function everyStringIsNonempty(): boolean {
  //@ verify
  //@ ensures \result === true
  return ["a", "bc"].every(value => value.length > 0);
}

export function sumStringLengths(): number {
  //@ verify
  //@ ensures \result === 3
  return ["a", "bc"].reduce((total, value) => total + value.length, 0);
}
