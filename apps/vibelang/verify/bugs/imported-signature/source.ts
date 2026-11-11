// Stays .ts: a LemmaScript defect reproduction (verify/README.md). Both functions prove in this module.
export interface Clock { readonly id: string; readonly at: number }
export type Op = "read" | "save"
//@ verify
//@ ensures \result.length == runs.length + 1
export function appended<R extends Clock>(runs: ReadonlyArray<R>, next: R): ReadonlyArray<R> {
  return [...runs, next]
}
//@ verify
//@ ensures \result == (op == "save")
export function writes(op: Op): boolean {
  return op === "save"
}
