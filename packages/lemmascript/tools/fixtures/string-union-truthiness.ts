// A string-literal union runs as a string, so its empty member is falsy in every truthiness position.
export type Color = "" | "red"

//@ verify
//@ ensures \result === (c === "red")
export function direct(c: Color): boolean {
  return c ? true : false
}

//@ verify
//@ ensures \result === (c === "")
export function negated(c: Color): boolean {
  return !c
}

//@ verify
//@ ensures c === "" ==> \result === 0
//@ ensures c === "red" ==> \result === 1
export function branch(c: Color): number {
  if (c) {
    return 1
  }
  return 0
}

//@ verify
//@ ensures \result === (c === "red")
export function present(c: Color | undefined): boolean {
  return c ? true : false
}

//@ verify
//@ ensures \result === (c !== "red")
export function absent(c: Color | undefined): boolean {
  return !c
}

//@ verify
//@ ensures \result === "red"
export function presentOr(c: Color | undefined): Color {
  return c || "red"
}

//@ verify
//@ ensures \result === "red"
export function fallback(c: Color): Color {
  return c || "red"
}
