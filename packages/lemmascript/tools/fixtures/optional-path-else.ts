// A field path proved present by a false absence check: the else-branch of a conditional, and the rest of a block
// after an early return, read it narrowed, through a method call on its fields.
export interface Item { readonly n: number; readonly label: string }
export interface Issues { readonly open: boolean; readonly items: ReadonlyArray<Item> }
export interface Model { readonly issues?: Issues }

//@ verify
//@ ensures model.issues === undefined ==> \result == ""
export function found(model: Model): string {
  return model.issues === undefined ? "" : model.issues.items.find(item => item.n > 0)?.label ?? ""
}

//@ verify
//@ ensures model.issues === undefined ==> \result == ""
//@ ensures model.issues !== undefined && model.issues.items.length == 0 ==> \result == "none"
export function foundAfterReturn(model: Model): string {
  if (model.issues === undefined) return ""
  return model.issues.items.find(item => item.n > 0)?.label ?? "none"
}
