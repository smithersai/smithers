// Two conditional spreads that write the same field, the second by shorthand: one update, the last one wins.
export interface Model { readonly status: string; readonly after: string; readonly count: number }

//@ verify
//@ ensures b ==> \result.after == after
//@ ensures !b && a ==> \result.after == ""
//@ ensures !b && !a ==> \result.after == model.after
export function written(model: Model, a: boolean, b: boolean, after: string): Model {
  return { ...model, ...(a ? { status: "ready", after: "" } : {}), ...(b ? { status: "ready", after } : {}) }
}
