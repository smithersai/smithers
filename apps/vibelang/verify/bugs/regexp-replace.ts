// LemmaScript reads TypeScript fixtures. A replacement is outside its literal-test subset.
//@ verify
//@ ensures \result.length >= 0
export function replaced(text: string): string {
  return text.replace(/\s+/, " ")
}
