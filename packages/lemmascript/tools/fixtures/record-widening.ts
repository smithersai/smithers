// A record without an optional field is assignable to the record with it (TypeScript is structural): the field is
// absent. A rest binding that drops an empty recovery key is such a record.
interface Request { readonly op: string; readonly key: string; readonly recovery?: string }
interface Draft { readonly op: string; readonly key: string; readonly recovery: string }

//@ verify
//@ ensures \result.op == draft.op && \result.key == draft.key
//@ ensures draft.recovery == "" ==> \result.recovery === undefined
//@ ensures draft.recovery != "" ==> \result.recovery !== undefined && \result.recovery == draft.recovery
export function request(draft: Draft): Request {
  const { recovery, ...rest } = draft
  return recovery === "" ? rest : { ...rest, recovery }
}
