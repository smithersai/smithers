// Two conditional spreads that write the same field: the first one does not win when both apply.
export interface Model { readonly status: string; readonly after: string; readonly count: number }

//@ verify
//@ ensures a && b ==> \result.after == ""
export function written(model: Model, a: boolean, b: boolean, after: string): Model {
  return { ...model, ...(a ? { status: "ready", after: "" } : {}), ...(b ? { status: "ready", after } : {}) }
}
