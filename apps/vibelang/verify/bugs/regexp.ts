// LemmaScript reads TypeScript fixtures. Literal tests are supported; native capture extraction is not.
//@ verify
//@ ensures \result.length >= 0
export function captured(text: string): string {
  return /^key:(.+)$/.exec(text)?.[1] ?? ""
}
