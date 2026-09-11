/** Shared best-effort boundaries for labeled PACKAGE.ts const declarations. */
export const declarationBindings = (source: string): ReadonlyArray<{ readonly name: string; readonly start: number; readonly end: number }> => {
  const starts = [...source.matchAll(/^[\t ]*(?:export[\t ]+)?const[\t ]+([A-Za-z_$][\w$]*)[\t ]*=/gm)]
  return starts.map((match, index) => ({
    name: match[1]!,
    start: match.index!,
    end: starts[index + 1]?.index ?? source.length
  }))
}
