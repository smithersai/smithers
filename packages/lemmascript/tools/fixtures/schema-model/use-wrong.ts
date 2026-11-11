import type { Model } from "./model"

// The wrong twin of `use.ts`: each contract claims what the body does not do, so each must fail its proof.
//@ verify
//@ ensures \result.previous == model.current
export function remember(model: Model): Model {
  return { ...model, current: model.previous }
}

//@ verify
//@ requires model.rows.length > 1
//@ ensures \result == model.rows[0].at
export function firstAt(model: Model): number {
  return model.rows[1]!.at
}
