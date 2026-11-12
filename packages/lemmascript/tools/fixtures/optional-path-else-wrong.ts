// An absent field path is not narrowed into a present one: the default is "", not "none".
export interface Item { readonly n: number; readonly label: string }
export interface Issues { readonly open: boolean; readonly items: ReadonlyArray<Item> }
export interface Model { readonly issues?: Issues }

//@ verify
//@ ensures model.issues === undefined ==> \result == "none"
export function foundAfterReturn(model: Model): string {
  if (model.issues === undefined) return ""
  return model.issues.items.find(item => item.n > 0)?.label ?? "none"
}
