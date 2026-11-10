// `forall` and `exists` are TypeScript names; only `forall(` and `exists(` open a quantifier.
//@ verify
//@ ensures \result == (!exists || forall)
//@ ensures exists && !forall ==> !\result
export function either(exists: boolean, forall: boolean): boolean { return !exists || forall }
