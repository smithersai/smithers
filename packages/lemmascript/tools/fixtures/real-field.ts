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


//@ verify
//@ ensures \result == (x !== undefined && x !== 0 ? 1 : 2)
export function chooseIf(x: real | undefined): number {
  if (x) return 1
  return 2
}

//@ verify
//@ ensures \result == (x !== undefined && x !== 0 ? 1 : 2)
export function chooseTernary(x: real | undefined): number {
  return x ? 1 : 2
}

//@ verify
//@ ensures \result == !(x !== undefined && x !== 0)
export function negateReal(x: real | undefined): boolean {
  return !x
}

//@ verify
//@ ensures \result == (x !== undefined && x !== 0 ? 1 : 2)
export function chooseNegatedIf(x: real | undefined): number {
  if (!x) return 2
  return 1
}

//@ verify
//@ ensures \result == (x !== undefined && x !== 0 ? 1 : 2)
export function chooseNegatedTernary(x: real | undefined): number {
  return !x ? 2 : 1
}

//@ verify
//@ ensures \result == (x === undefined || x === 0 ? 0.5 : x)
export function defaultReal(x: real | undefined): real {
  return x || 0.5
}


//@ verify
//@ ensures \result == (x !== undefined && x > 0 ? 1 : 2)
export function chooseNegatedOr(x: real | undefined): number {
  if (!x || x < 0) return 2
  return 1
}
