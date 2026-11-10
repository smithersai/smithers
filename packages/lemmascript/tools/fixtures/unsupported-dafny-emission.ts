export function usesRound(n: number): number {
  //@ verify
  //@ ensures \result >= 0
  const pct = Math.round(n / 2);
  return pct > 0 ? pct : 0;
}
