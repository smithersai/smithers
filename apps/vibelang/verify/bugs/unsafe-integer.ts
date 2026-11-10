// LemmaScript reads .ts only; this fixture exposes its integer model versus native JavaScript numbers.
//@ verify
//@ ensures \result > rank
export function nextRank(rank: number): number {
  return rank + 1
}
