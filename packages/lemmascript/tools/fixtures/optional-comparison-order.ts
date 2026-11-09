export function belowOrUnset(x: number, opt: number | null): boolean {
  //@ ensures x === 1 && opt === 5 ==> \result
  //@ ensures x === 5 && opt === 1 ==> !\result
  return opt === null || x < opt;
}

export function atMostOrUnset(x: number, opt: number | null): boolean {
  //@ ensures x === 5 && opt === 5 ==> \result
  //@ ensures x === 6 && opt === 5 ==> !\result
  return opt === null || x <= opt;
}

export function aboveOrUnset(x: number, opt: number | null): boolean {
  //@ ensures x === 5 && opt === 1 ==> \result
  //@ ensures x === 1 && opt === 5 ==> !\result
  return opt === null || x > opt;
}

export function atLeastOrUnset(x: number, opt: number | null): boolean {
  //@ ensures x === 5 && opt === 5 ==> \result
  //@ ensures x === 4 && opt === 5 ==> !\result
  return opt === null || x >= opt;
}

export function optionalOnLeft(x: number, opt: number | null): boolean {
  //@ ensures x === 1 && opt === 5 ==> \result
  //@ ensures x === 5 && opt === 1 ==> !\result
  return opt === null || opt > x;
}
