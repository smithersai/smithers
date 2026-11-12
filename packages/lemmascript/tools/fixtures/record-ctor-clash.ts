// A record named like a string-union member: Dafny shares one constructor namespace across datatypes, so the record's
// constructor and the union's are both qualified.
export type Kind = "All" | "Issues"
export interface Issues { readonly kind: Kind; readonly count: number }

//@ verify
//@ ensures \result.kind == "Issues" && \result.count == n
export function made(n: number): Issues {
  return { kind: "Issues", count: n }
}

//@ verify
//@ ensures \result == { ...issues, count: issues.count + 1 }
export function counted(issues: Issues): Issues {
  return { kind: issues.kind, count: issues.count + 1 }
}
