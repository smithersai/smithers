// The clamp's floor is 60, not 61: claiming more must fail.
type real = number

//@ verify
//@ ensures \result >= 61
export function clampedTop(top: real, menu: real): real {
  return Math.max(60, Math.min(top, menu))
}
