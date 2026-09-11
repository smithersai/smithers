/** One path/repository token, shared by buttons, forms and slash parsing. */
export const quoteFileArg = (value: string): string =>
  value === "" || /[\s"'\\]/.test(value) ? JSON.stringify(value) : value

export const fileArgs = (...values: ReadonlyArray<string | undefined>): string =>
  values.filter((value): value is string => value !== undefined).map(quoteFileArg).join(" ")

/** Quotes preserve whitespace in file names; unquoted backslashes remain literal. */
export const parseFileArgs = (input: string | undefined): { readonly tokens: Array<string> } | { readonly error: string } => {
  const tokens: Array<string> = []
  const text = input ?? ""
  let index = 0
  while (index < text.length) {
    while (/\s/.test(text[index] ?? "") && index < text.length) index += 1
    if (index >= text.length) break
    const quote = text[index]
    if (quote !== '"' && quote !== "'") {
      const start = index
      while (index < text.length && !/\s/.test(text[index]!)) index += 1
      tokens.push(text.slice(start, index))
      continue
    }
    const start = index++
    let value = ""
    let closed = false
    while (index < text.length) {
      const character = text[index++]!
      if (character === quote) {
        closed = true
        break
      }
      if (quote === '"' && character === "\\" && index < text.length) {
        value += character + text[index++]!
      } else value += character
    }
    if (!closed || (index < text.length && !/\s/.test(text[index]!))) return { error: "Close the quoted file argument before the next argument." }
    if (quote === '"') {
      try { value = JSON.parse(text.slice(start, index)) as string }
      catch { return { error: "The quoted file argument contains an invalid escape." } }
    }
    tokens.push(value)
  }
  return { tokens }
}
