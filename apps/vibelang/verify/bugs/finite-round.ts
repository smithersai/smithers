// LemmaScript reads TypeScript; this is a minimal backend-gap reproduction.
//@ verify
//@ ensures \result >= 0
export function normalize(used: number): number {
 return Number.isFinite(used) ? Math.max(0, Math.round(used)) : 0
}
