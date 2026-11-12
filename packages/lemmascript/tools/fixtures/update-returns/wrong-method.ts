// A string method LemmaScript does not model is not known to return its receiver.
//@ verify
//@ ensures \result == text
export function shown(text: string): string {
  return text.toWellFormed()
}
