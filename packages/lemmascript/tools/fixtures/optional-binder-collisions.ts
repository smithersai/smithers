export interface Box { b?: number }
export interface Left { b_c?: number }
export interface Right { c?: number }

export function counterCollision(oc0: number | undefined, xs: number[] | undefined): boolean {
  if (oc0 !== undefined) return xs?.includes(oc0) ?? false;
  return false;
}

export function addPaths(a_b: number | undefined, a: Box): number {
  //@ ensures a_b === 3 && a.b === 7 ==> \result === 10
  if (a_b !== undefined) {
    if (a.b !== undefined) return a_b + a.b;
  }
  return -1;
}

export function addFields(a: Left, a_b: Right): number {
  //@ ensures a.b_c === 2 && a_b.c === 9 ==> \result === 11
  if (a.b_c !== undefined) {
    if (a_b.c !== undefined) return a.b_c + a_b.c;
  }
  return -1;
}

export function addWithUserName(a_b: number | undefined, a: Box, _a_b_val: number): number {
  //@ ensures a_b === 3 && a.b === 7 && _a_b_val === 11 ==> \result === 21
  if (a_b !== undefined) {
    if (a.b !== undefined) return a_b + a.b + _a_b_val;
  }
  return -1;
}

export function earlyReturn(a_b: number | undefined, a: Box): number {
  //@ ensures a_b === 3 && a.b === 7 ==> \result === 10
  if (a_b === undefined || a.b === undefined) return -1;
  return a_b + a.b;
}

export function addMethod(a_b: number | undefined, a: Box): number {
  //@ ensures a_b === 3 && a.b === 7 ==> \result === 10
  let result = -1;
  if (a_b !== undefined) {
    if (a.b !== undefined) result = a_b + a.b;
  }
  return result;
}
