// LemmaScript reads TypeScript; this is a minimal backend-gap reproduction.
//@ verify
//@ ensures \result == value
export function roundtrip(value: string): string { return decodeURIComponent(encodeURIComponent(value)) }
