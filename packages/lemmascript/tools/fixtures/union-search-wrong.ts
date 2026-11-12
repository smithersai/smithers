// The list lacks "draft": claiming every member must fail.
export type Op = "read" | "save" | "draft"

//@ verify
//@ ensures \result.includes("read") && \result.includes("save") && \result.includes("draft")
export function ops(): ReadonlyArray<Op> {
  return ["read", "save"]
}
