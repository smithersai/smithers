// One string-literal union is one type however it is written: a named alias, a second alias of the same members, or
// an inline union in a record field. A screen read from a record, and a record written from a screen, need no cast.
export type Pane = "closed" | "pane" | "max"
export type Size = "closed" | "pane" | "max"
interface Model { readonly pane?: "closed" | "pane" | "max"; readonly size: "max" | "pane" | "closed"; readonly label: string }
interface Screen { readonly pane: Pane; readonly size: Size }

//@ verify
//@ ensures \result == { pane: model.pane ?? "closed", size: model.size }
export function screen(model: Model): Screen {
  return { pane: model.pane ?? "closed", size: model.size }
}

//@ verify
//@ ensures \result.size == view.pane && \result.label == model.label
export function written(model: Model, view: Screen): Model {
  return { ...model, size: view.pane }
}

//@ verify
//@ ensures \result == (view.size == "max")
export function maximized(view: Screen): boolean {
  return view.size === "max"
}

//@ verify
//@ ensures \result.size == "max" && \result.pane == "closed"
export function opened(): Screen {
  return { pane: "closed", size: "max" }
}

//@ verify
//@ ensures \result == (model.pane == "max")
export function paneMax(model: Model): boolean {
  return model.pane === "max"
}

// A parameter typed by an indexed access to a literal-union field (`Model["size"]`, `NonNullable<Model["pane"]>`) is
// that union, not a plain string, so writing it back into the field needs no cast.
//@ verify
//@ ensures \result == { ...model, size: size, pane: pane }
export function placed(model: Model, size: Model["size"], pane: NonNullable<Model["pane"]>): Model {
  return { ...model, size, pane }
}
