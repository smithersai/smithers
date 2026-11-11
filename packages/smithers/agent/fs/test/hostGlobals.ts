// Host reads the .vibe tests of this package cannot spell (VIP-33; detail 272, fourth addendum):
// in a .vibe file `Request` names Effect's prelude module and `globalThis` is not a value. The moved expressions, unchanged.
export const Request = globalThis.Request
export type Request = globalThis.Request
export const hostGlobals = globalThis
