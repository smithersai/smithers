// A conditional spread of two object literals; each branch's fields overwrite, others show through.
type Model = { readonly surface: "chat" | "splash"; readonly k: number; readonly on: boolean }

//@ verify
//@ ensures c ==> \result.surface == "chat"
//@ ensures !c ==> \result.surface == model.surface
//@ ensures \result.k == model.k && \result.on == model.on
function one(model: Model, c: boolean): Model { return { ...model, ...(c ? { surface: "chat" as const } : {}) } }

//@ verify
//@ ensures c ==> \result.k == 1 && \result.on == true
//@ ensures !c ==> \result.k == 2 && \result.on == model.on
//@ ensures \result.surface == "splash"
function both(model: Model, c: boolean): Model { return { ...model, surface: "splash", ...(c ? { k: 1, on: true } : { k: 2 }) } }
