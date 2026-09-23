/**
 * pi's fuzzy matcher (`packages/tui/src/fuzzy.ts`): the query's letters must
 * appear in order. Lower scores are better; runs and word boundaries earn,
 * gaps and late matches cost.
 */

const boundary = /[\s\-_./:]/

/** The score of `query` against `text`, or undefined when it does not match. */
export const score = (query: string, text: string): number | undefined => {
  const needle = query.toLowerCase()
  const haystack = text.toLowerCase()
  if (needle === "") return 0
  if (needle === haystack) return -100
  let total = 0
  let at = 0
  let run = 0
  let previous = -1
  for (const character of needle) {
    const found = haystack.indexOf(character, at)
    if (found < 0) return undefined
    if (found === previous + 1) {
      run++
      total -= 5 * run
    } else {
      run = 0
      if (previous >= 0) total += 2 * (found - previous - 1)
    }
    if (found === 0 || boundary.test(haystack[found - 1]!)) total -= 10
    total += 0.1 * found
    previous = found
    at = found + 1
  }
  return total
}

/**
 * The items every space- or slash-separated token of `query` matches, best
 * first; ties keep their original order.
 */
export const filter = <A>(items: ReadonlyArray<A>, query: string, text: (item: A) => string): Array<A> => {
  const tokens = query.split(/[\s/]+/).filter((token) => token !== "")
  if (tokens.length === 0) return [...items]
  const scored: Array<{ readonly item: A; readonly score: number; readonly index: number }> = []
  items.forEach((item, index) => {
    const subject = text(item)
    let sum = 0
    for (const token of tokens) {
      const each = score(token, subject)
      if (each === undefined) return
      sum += each
    }
    scored.push({ item, score: sum, index })
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((entry) => entry.item)
}
