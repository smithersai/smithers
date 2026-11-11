import type { Model } from "./model"
import { owner } from "./rest-owner"

// A rest binding of a schema model is the model with the omitted optional field absent. Its type stays `Model`: named
// from the binding instead (`Destr0`), it took the model's place, and an imported contract that narrows an optional
// field of `Model` (`owner`) no longer resolved.
//@ verify
//@ ensures \result == model
export function signedOut(model: Model): Model {
  const { account: dropped, ...kept } = model
  return kept
}

//@ verify
//@ ensures model.account === undefined ==> \result == ""
export function ownerName(model: Model): string {
  return owner(model)
}
