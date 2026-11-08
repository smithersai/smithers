// LemmaScript reads TypeScript; this is a minimal backend-gap reproduction.
const WORDS = { yes: "accepted", no: "refused" } as const
//@ verify
//@ ensures flag ==> \result == "accepted"
//@ ensures !flag ==> \result == "refused"
export function word(flag: boolean): string { return flag ? WORDS.yes : WORDS.no }
