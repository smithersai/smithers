export const LIMIT = 8

//@ verify
//@ ensures \result <= LIMIT
export function clamp(n: number): number { return n > LIMIT ? LIMIT : n }
