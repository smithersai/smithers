// LemmaScript reads TypeScript defect reproductions.
type Reason = "empty" | "full"
type Answer = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: Reason }
//@ verify
//@ ensures !\result.ok && \result.reason == "full"
export function full(): Answer {
  return { ok: false, reason: "full" }
}
