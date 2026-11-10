//@ option extern-default pure

//@ extern
declare function rollDie(): number;

export function deterministicDraw(): number {
  return rollDie();
}
