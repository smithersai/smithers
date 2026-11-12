// A constant of a record type declared beside it, read by another module.
export interface Step { readonly target: string; readonly duration: number }
export const STEPS: ReadonlyArray<Step> = [{ target: "splash", duration: 7 }, { target: "palette", duration: 22 }]
