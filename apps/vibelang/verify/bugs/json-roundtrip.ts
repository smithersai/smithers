// LemmaScript reads TypeScript defect reproductions.
export interface Message { readonly id: string; readonly sequence: number; readonly text: string }
//@ verify
//@ requires 0 <= input.sequence && input.sequence <= 9007199254740991
//@ ensures \result.id == input.id && \result.sequence == input.sequence && \result.text == input.text
export function roundtrip(input: Message): Message {
  return JSON.parse(JSON.stringify(input)) as Message
}
