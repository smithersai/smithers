// A string literal searched for in a string-union array (`includes`, `indexOf`) is that union's
// member, as TypeScript reads it, never a Dafny string compared with the union.
export type Op = "read" | "save" | "draft"

//@ verify
//@ ensures \result.includes("read") && \result.includes("save") && \result.includes("draft")
export function ops(): ReadonlyArray<Op> {
  return ["read", "save", "draft"]
}

//@ verify
//@ ensures \result == ops.includes("save")
export function saves(ops: ReadonlyArray<Op>): boolean {
  return ops.indexOf("save") >= 0
}

