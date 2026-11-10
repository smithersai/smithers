// LemmaScript reads TypeScript fixtures; both nullable-record guard clauses are retained.
interface Stop { readonly target: string }
//@ verify
//@ ensures \result == (saved != null && saved.target != "")
export function restored(saved: Stop | null): boolean {
  return saved !== null && saved.target !== ""
}
