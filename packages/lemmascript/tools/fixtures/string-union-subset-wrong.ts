// Each member widens to the superset member of the same spelling: claiming another must fail.
export type Kind = "start" | "stop"
export type Operation = Kind | ""
export interface S { readonly operation: Operation }

//@ verify
//@ ensures kind == "stop" ==> \result.operation == "start"
export function set(s: S, kind: Kind): S { return { ...s, operation: kind } }
