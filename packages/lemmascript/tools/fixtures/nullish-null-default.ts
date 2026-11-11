// `x ?? null` and `x ?? undefined` keep the optional: an absent value stays absent, a present one is unchanged.
export interface Request { readonly op: string; readonly key: string }
export interface Ui { readonly retry?: Request }

//@ verify
//@ ensures ui.retry === undefined ==> \result === undefined
//@ ensures ui.retry !== undefined ==> \result === ui.retry.op
export function retryOp(ui: Ui): string | null {
  return ui.retry?.op ?? null
}

//@ verify
//@ ensures \result === x
export function same(x: number | undefined): number | undefined {
  return x ?? undefined
}
