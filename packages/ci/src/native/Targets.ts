/**
 * Which targets a replay runs on a repository that already builds with
 * Smithers build: the patterns its CI gives `smthrs`.
 *
 * @since 0.1.0
 */

import { ciJobs, type Inventory, type Job, type NotReplayed, withVariant } from "../contract/Inventory.ts"

/**
 * The pattern for every target of a workspace. It is replayed when the
 * repository's CI names no pattern.
 *
 * @category constants
 * @since 0.1.0
 */
export const everything = "//..."

/**
 * The `Unsupported.feature` of a CI job no step of which runs a Smithers
 * build target. Its commands are not replayed.
 *
 * @category constants
 * @since 0.1.0
 */
export const notTargets = "not-smithers-build"

/**
 * The `Unsupported.feature` of a CI job whose targets were not all asked for.
 *
 * @category constants
 * @since 0.1.0
 */
export const notSelected = "not-selected"

/**
 * The patterns a replay runs, where they came from, and the CI jobs they do
 * not cover. `request` is what the caller named, `ci` what the repository's
 * CI runs, and `default` is {@link everything}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Chosen {
  readonly patterns: ReadonlyArray<string>
  readonly from: "request" | "ci" | "default"
  readonly left: ReadonlyArray<NotReplayed>
}

/** The names Smithers build's command-line program is installed under. */
const programs: ReadonlyArray<string> = ["smthrs", "smithers-build"]

/** The verbs that run targets. `smthrs ci` runs what each of the others selects. */
const verbs: ReadonlyArray<string> = ["ci", "test", "lint", "build"]

interface Word {
  readonly text: string
  readonly operator: boolean
}

/**
 * The words of a shell command, unquoted as a shell does it: quoted and bare
 * pieces that touch are one word, `'\''` is a quote inside single quotes, and
 * a backslash before a line end joins two lines. `;`, `&`, `|` and a line end
 * close a command and are words of their own.
 */
const wordsOf = (command: string): ReadonlyArray<Word> => {
  const words: Array<Word> = []
  let text: string | undefined = undefined
  const close = (): void => {
    if (text !== undefined) words.push({ text, operator: false })
    text = undefined
  }
  for (let at = 0; at < command.length; at++) {
    const char = command.charAt(at)
    if (char === "'" || char === "\"") {
      const end = command.indexOf(char, at + 1)
      const stop = end === -1 ? command.length : end
      text = (text ?? "") + command.slice(at + 1, stop)
      at = stop
    } else if (char === "\\") {
      at += 1
      if (command.charAt(at) !== "\n") text = (text ?? "") + command.charAt(at)
    } else if (";&|\n".includes(char)) {
      close()
      words.push({ text: char, operator: true })
    } else if (char === " " || char === "\t") {
      close()
    } else {
      text = (text ?? "") + char
    }
  }
  close()
  return words
}

const isProgram = (word: Word): boolean => !word.operator && programs.includes(word.text.replace(/^.*\//, ""))

/** A label or a pattern as written, with nothing left for the shell or the CI host to fill in. */
const isPattern = (word: Word): boolean => word.text.startsWith("//") && !word.text.includes("$")

/** A word that is itself a script, as the argument of `bash -c` is. */
const isScript = (word: Word): boolean => !word.operator && /\s/.test(word.text)

/**
 * The target patterns a shell command gives Smithers build: every argument
 * that starts with `//` after `smthrs ci`, `test`, `lint` or `build`, in the
 * command or in a script it quotes, such as the argument of `bash -c`. A
 * pattern a variable holds is not one.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const patternsIn = (command: string): ReadonlyArray<string> => {
  const words = wordsOf(command)
  return words.flatMap((word, index) => {
    if (isScript(word)) return patternsIn(word.text)
    const verb = words[index + 1]
    if (!isProgram(word) || verb === undefined || !verbs.includes(verb.text)) return []
    const rest = words.slice(index + 2)
    const end = rest.findIndex((next) => next.operator)
    return (end === -1 ? rest : rest.slice(0, end)).filter(isPattern).map((next) => next.text)
  })
}

const patternsOf = (job: Job): ReadonlyArray<string> => {
  const variants: ReadonlyArray<Readonly<Record<string, string>>> = job.matrix.length === 0 ? [{}] : job.matrix
  return variants.flatMap((variant) => job.steps.flatMap((step) => patternsIn(withVariant(step, variant).command)))
}

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)]

/**
 * Whether every target `pattern` selects is selected by `asked`: the same
 * pattern, `//...`, `//a/...` for anything in or under `//a`, or `//a:*` for a
 * target of `//a`.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const covers = (asked: string, pattern: string): boolean => {
  if (asked === pattern || asked === everything) return true
  if (asked.endsWith("/...")) {
    const base = asked.slice(0, -"/...".length)
    return pattern.startsWith(`${base}:`) || pattern.startsWith(`${base}/`)
  }
  return asked.endsWith(":*") && pattern.startsWith(asked.slice(0, -1))
}

/**
 * The patterns to replay for an inventory: `requested` when given, else
 * every pattern a job that runs on a change gives Smithers build, else
 * {@link everything}. `left` lists each such job with a step that the
 * patterns do not cover: one that runs no target, or one with a pattern that
 * no requested pattern {@link covers}.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const chosenFor = (inventory: Inventory, requested?: ReadonlyArray<string>): Chosen => {
  const jobs = ciJobs(inventory).filter((job) => job.steps.length > 0).map((job) => ({
    job,
    patterns: unique(patternsOf(job))
  }))
  const fromCi = unique(jobs.flatMap((entry) => entry.patterns))
  const asked = requested !== undefined && requested.length > 0
  const patterns = asked ? unique(requested) : fromCi.length > 0 ? fromCi : [everything]
  const left = jobs.flatMap((entry): ReadonlyArray<NotReplayed> => {
    const file = entry.job.file
    if (entry.patterns.length === 0) {
      return [{
        job: entry.job.id,
        reasons: [{ feature: notTargets, detail: `${file}: no step runs Smithers build targets` }]
      }]
    }
    const missing = entry.patterns.filter((pattern) => !patterns.some((asked) => covers(asked, pattern)))
    if (missing.length === 0) return []
    const detail = `${file}: ${missing.length} of its ${entry.patterns.length} patterns are not among those asked for`
    return [{ job: entry.job.id, reasons: [{ feature: notSelected, detail }] }]
  })
  return { patterns, from: asked ? "request" : fromCi.length > 0 ? "ci" : "default", left }
}
