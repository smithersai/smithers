// LemmaScript reads TypeScript fixtures; this isolates optional member default contract emission.
interface Input { readonly value: string | undefined }
//@ verify
//@ ensures \result == (input.value == undefined ? fallback : input.value)
export function valueOf(input: Input, fallback: string): string {
  return input.value ?? fallback
}
