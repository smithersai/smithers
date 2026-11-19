/**
 * What a replay tells the person when this machine cannot record which files
 * a step reads. Without that record a step that names no inputs runs on every
 * commit, and the report alone does not say why.
 *
 * @since 0.1.0
 */

/**
 * What a `smthrs` run is told so that it prints its notes, this one included,
 * when a coding agent started `smithers-ci`: it writes less for an agent.
 *
 * @category constants
 * @since 0.1.0
 */
export const printsNotes = { SMITHERS_AUDIENCE: "human" } as const

/**
 * The line `smthrs` prints once a run, with what follows the reason cut off.
 * It may stand behind the frame of its display; a step's own output stands
 * behind its target's label.
 */
const unobserved = /^\W*smthrs: reads are not observed on this host: (.+?)(?:; a target that asks for it .*)?$/

/** What a program calls each system, and what a person calls it. */
const systems: ReadonlyArray<readonly [RegExp, string]> = [[/\bdarwin\b/g, "macOS"], [/\bwin32\b/g, "Windows"]]

/**
 * A reason the machine's own programs give, with the system named as a
 * person names it: `this host is darwin` reads `this host is macOS`.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const inPlainWords = (reason: string): string =>
  systems.reduce((text, [name, plain]) => text.replace(name, plain), reason)

/**
 * The sentence for a machine that cannot record reads, for the reason
 * Smithers build gives.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const cannotRecord = (reason: string): string =>
  `this machine cannot record what a step reads (${
    inPlainWords(reason)
  }). A step that names no inputs runs on every commit. On Linux, install strace.`

/**
 * A listener for the output of `smthrs` runs, chunk by chunk. It returns the
 * sentence the first time a whole line says reads are not recorded, and
 * `undefined` for every other chunk, so one replay says it once.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export const readsListener = (): (chunk: string) => string | undefined => {
  let partial = ""
  let told = false
  return (chunk) => {
    const lines = `${partial}${chunk}`.split("\n")
    partial = lines.pop() as string
    if (told) return undefined
    for (const line of lines) {
      const reason = unobserved.exec(line.trimEnd())?.[1]
      if (reason !== undefined) {
        told = true
        return cannotRecord(reason)
      }
    }
    return undefined
  }
}
