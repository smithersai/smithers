// A record field declared `real` holds fractional values, like a `real` parameter.
type real = number
export interface Spot { readonly intent: number; readonly y: real }

//@ verify
//@ ensures \result.y == y && \result.intent == spot.intent + 1
export function moved(spot: Spot, y: real): Spot {
  return { intent: spot.intent + 1, y }
}

//@ verify
//@ ensures \result == (spot.y > y)
export function above(spot: Spot, y: real): boolean {
  return spot.y > y
}
