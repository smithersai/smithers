// A split by a regular expression is not known to give one word.
//@ verify
//@ ensures \result.length == 1
export function words(text: string): ReadonlyArray<string> {
  return text.trim().split(/\s+/)
}
