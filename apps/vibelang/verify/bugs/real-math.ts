// LemmaScript reads TypeScript. Math.max/Math.min over real values lower to the int-only MathMax/MathMin helpers,
// and an integer literal in a real conditional branch is not coerced. The tour spotlight's box clamps this way.
type real = number

//@ verify
//@ ensures \result >= 60
export function clampedTop(top: real, menu: real, hasMenu: boolean): real {
  return Math.max(60, Math.min(top, hasMenu ? menu : 80))
}
