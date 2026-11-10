//@ pure
//@ impure
//@ extern
declare function rollDie(): number;

export function conflictingDraw(): number {
  return rollDie();
}
