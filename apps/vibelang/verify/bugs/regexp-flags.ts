// LemmaScript reads TypeScript fixtures. Case-insensitive native tests are outside its literal subset.
//@ verify
export function flagged(text: string): boolean {
  return /wiki/i.test(text)
}
