//@ option safe-slice false

//@ extern
declare function rollDie(): number;

export function configuredDraw(): number {
  return rollDie();
}

export function boundedSlice(xs: number[]): number[] {
  return xs.slice(0, xs.length);
}
