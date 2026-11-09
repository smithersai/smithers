// A spread of a call returning a subset of the base record's fields.
type Model = { readonly surface: "chat" | "splash"; readonly k: number }
type Patch = { readonly surface: "chat" | "splash" }

//@ verify
//@ ensures \result.surface == "chat"
function decide(model: Model): Patch { return { surface: "chat" } }

//@ verify
//@ ensures \result.surface == "chat" && \result.k == model.k
function arm(model: Model): Model { return { ...model, ...decide(model) } }
