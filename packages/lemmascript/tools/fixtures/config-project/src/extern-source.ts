export function defaultRoll(): number {
  return Math.random();
}

//@ pure
export const stableRoll = (): number => Math.random();
