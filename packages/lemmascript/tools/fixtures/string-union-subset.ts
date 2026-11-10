// A string-literal union value passes where a superset union is expected, as TypeScript allows.
export type Kind = "start" | "stop"
export type Operation = Kind | "" | "none"
export interface S { readonly operation: Operation }

//@ verify
//@ ensures \result.operation == kind
export function set(s: S, kind: Kind): S { return { ...s, operation: kind } }

//@ verify
//@ ensures \result == (op == "start")
export function isStart(op: Operation): boolean { return op === "start" }

//@ verify
//@ ensures \result == (kind == "start")
export function kindIsStart(kind: Kind): boolean { return isStart(kind) }

//@ verify
//@ ensures \result == (op == kind)
export function same(op: Operation, kind: Kind): boolean { return op === kind }

//@ verify
//@ ensures active ==> \result == kind
//@ ensures !active ==> \result == "none"
export function pick(active: boolean, kind: Kind): Operation { return active ? kind : "none" }

export interface Step { readonly state: S; readonly count: number }

//@ verify
//@ ensures \result.state == { ...s, operation: kind }
export function nested(s: S, kind: Kind): Step { return { state: { ...s, operation: kind }, count: 0 } }
