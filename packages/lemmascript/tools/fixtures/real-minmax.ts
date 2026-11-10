// Math.max/Math.min over real values compare as reals, and an integer branch of a real conditional is a real.
type real = number

//@ verify
//@ ensures \result >= 60 && \result >= Math.min(top, hasMenu ? menu : 80)
export function clampedTop(top: real, menu: real, hasMenu: boolean): real {
  return Math.max(60, Math.min(top, hasMenu ? menu : 80))
}

//@ verify
//@ ensures \result >= 1
//@ ensures right - left >= 1 ==> \result == right - left
export function span(left: real, right: real): real {
  return Math.max(1, right - left)
}

//@ verify
//@ ensures \result == (x > 0 ? x : 0)
export function positive(x: real): real {
  return x > 0 ? x : 0
}

//@ verify
//@ ensures \result == (a <= b ? a : b)
export function smaller(a: number, b: number): number {
  return Math.min(a, b)
}
