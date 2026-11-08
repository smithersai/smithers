// LemmaScript reads TypeScript; this is a minimal backend-gap reproduction.
//@ verify
//@ ensures \result ==> path.length > 0
export function docs(path: string): boolean { return /^\/[a-z0-9\-\/]*$/.test(path) && !path.includes("//") }
