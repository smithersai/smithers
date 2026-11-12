// A record named like a string-union member keeps its own values: the count is not one more.
export type Kind = "All" | "Issues"
export interface Issues { readonly kind: Kind; readonly count: number }

//@ verify
//@ ensures \result.count == n + 1
export function made(n: number): Issues {
  return { kind: "Issues", count: n }
}
