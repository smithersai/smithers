// Between 0 and 1 lies a real, but no integer: modelling the field as an integer would prove this.
type real = number
export interface Spot { readonly y: real }

//@ verify
//@ ensures !\result
export function between(spot: Spot): boolean {
  return spot.y > 0 && spot.y < 1
}
