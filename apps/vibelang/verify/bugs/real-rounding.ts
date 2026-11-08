// LemmaScript reads TypeScript; exact real arithmetic does not model native IEEE-754 rounding.
type real = number
//@ verify
//@ ensures height == 100 && viewport == 50 && y < 2 ==> !\result
export function nearBottom(height: real, viewport: real, y: real): boolean {
  return height - viewport - y <= 48
}
