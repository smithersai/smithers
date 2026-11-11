// A module constant extraction cannot model aborts generation before any file is written. (A RegExp literal was the
// example here until LemmaScript read RegExp constants where they are tested.)
const UNSUPPORTED_VALUE = new Date(0);

export function fine(n: number): number {
  //@ verify
  //@ ensures \result >= 0
  return n >= 0 ? n : 0;
}
