import type { Model } from "./model"

// Proved beside `rest.ts`, which reads this contract as an axiom: its narrowed optional field needs `Model`'s datatype.
//@ verify
//@ ensures model.account !== undefined ==> \result == model.account.name
//@ ensures model.account === undefined ==> \result == ""
export function owner(model: Model): string {
  return model.account?.name ?? ""
}
