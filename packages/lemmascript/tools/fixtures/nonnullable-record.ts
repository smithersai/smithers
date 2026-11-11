// `NonNullable<Model["edit"]>` is the record the optional field holds, not an opaque type.
interface Model { readonly edit?: { readonly text: string }; readonly count: number }

//@ verify
//@ ensures \result == edit.text
export function text(edit: NonNullable<Model["edit"]>): string { return edit.text; }

//@ verify
//@ ensures model.edit === undefined ==> \result == ""
//@ ensures model.edit !== undefined ==> \result == model.edit.text
export function current(model: Model): string { return model.edit === undefined ? "" : text(model.edit); }
