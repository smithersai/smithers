// Stays .ts: the literal "save" passed to the imported `writes` stays a Dafny string ("incorrect argument type for
// function parameter 'op' (expected Op, found string)"); in one module the same call proves. The imported generic
// `appended` resolves here, from TypeScript source; imported from a staged `.vibe` declaration its bound was lost
// (0018, "Web views batch").
import { appended, type Clock, writes } from "./source"
//@ verify
//@ ensures \result.length == runs.length + 1
export function add<R extends Clock>(runs: ReadonlyArray<R>, next: R): ReadonlyArray<R> {
  return appended(runs, next)
}
//@ verify
//@ ensures \result
export function saves(): boolean {
  return writes("save")
}
