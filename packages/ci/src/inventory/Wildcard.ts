/**
 * Wildcard matching for workflow branch names and package paths.
 *
 * @since 0.1.0
 */

/**
 * Match a token sequence in polynomial time, retaining one row of reachable input positions.
 *
 * @category readers
 * @since 0.1.0
 */
export const wildcard = (
  pattern: ReadonlyArray<string>,
  input: ReadonlyArray<string>,
  star: (token: string) => boolean,
  accepts: (token: string, item: string) => boolean
): boolean => {
  const reachable = new Uint8Array(input.length + 1)
  reachable[0] = 1
  for (const token of pattern) {
    if (star(token)) {
      for (let i = 0; i < input.length; i++) {
        if (reachable[i] && accepts(token, input[i] as string)) reachable[i + 1] = 1
      }
    } else {
      for (let i = input.length; i > 0; i--) {
        reachable[i] = reachable[i - 1] && accepts(token, input[i - 1] as string) ? 1 : 0
      }
      reachable[0] = 0
    }
  }
  return reachable[input.length] === 1
}
