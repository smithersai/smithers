// A spread override with optional fields merges field by field; its call reads a narrowed `??`.
export interface Model { readonly page?: string; readonly last?: string; readonly count: number }

//@ verify
//@ ensures \result.count == model.count && \result.last == model.last
//@ ensures model.last === undefined || model.last == "" ==> \result.page == model.page
//@ ensures model.last !== undefined && model.last != "" ==> \result.page == model.last
export function reopened(model: Model): Model {
  return { ...model, ...visit(model.last ?? "") }
}

//@ verify
//@ ensures \result.page == (page == "" ? undefined : page)
export function visit(page: string): { readonly page?: string } {
  return page === "" ? {} : { page }
}
