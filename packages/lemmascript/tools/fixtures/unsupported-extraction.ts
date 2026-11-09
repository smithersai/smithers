const UNSUPPORTED_PATTERN = /x/;

export function fine(n: number): number {
  //@ verify
  //@ ensures \result >= 0
  return n >= 0 ? n : 0;
}
