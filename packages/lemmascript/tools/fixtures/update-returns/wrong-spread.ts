// A reopened model takes the visited page, not its own.
export interface Model { readonly page?: string; readonly last?: string; readonly count: number }

//@ verify
//@ ensures \result.page == model.page
export function reopened(model: Model): Model {
  return { ...model, ...visit(model.last ?? "") }
}

//@ verify
//@ ensures \result.page == (page == "" ? undefined : page)
export function visit(page: string): { readonly page?: string } {
  return page === "" ? {} : { page }
}
