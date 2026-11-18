/**
 * What a replay says about one run: the reason each failed target gave, and,
 * for a repository's own targets, a line per run for the person waiting.
 *
 * @since 0.1.0
 */

import { type TargetResult, verdictOf } from "../contract/RunRecord.ts"
import { failuresOf, firstLine, printedFailure, sentenceOf } from "../replay/Failures.ts"

/**
 * What `smthrs` printed for each failed target, by label. Its plain output
 * gives a failure a line with the label, `failed`, the time and the reason,
 * and then what the command printed, up to the next target or the closing
 * `code:` line.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const reasonsIn = (output: string): ReadonlyMap<string, string> => {
  const found = new Map<string, Array<string>>()
  let open: Array<string> | undefined
  for (const line of output.split("\n")) {
    const header = /^(\/\/\S+) +failed +\S+ +(.+)$/.exec(line)
    if (header !== null) {
      open = [header[2] as string]
      found.set(header[1] as string, open)
    } else if (/^(?:\/\/\S+ {2}|code: )/.test(line)) open = undefined
    else open?.push(line)
  }
  return new Map([...found].map(([label, lines]) => [label, lines.join("\n").trimEnd()]))
}

/**
 * The results with the reason `smthrs` printed added to each failed target
 * whose record has none, with its exit code and command when it gave them.
 * `smthrs` writes no reason in its run record.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const withReasons = (results: ReadonlyArray<TargetResult>, output: string): ReadonlyArray<TargetResult> => {
  const reasons = reasonsIn(output)
  return results.map((result) => {
    const reason = reasons.get(result.label)
    return result.status === "failed" && result.error === undefined && reason !== undefined
      ? { ...result, ...printedFailure(reason) }
      : result
  })
}

/**
 * The label of the result that stands for a run `smthrs ci` could not plan:
 * it wrote no run record, so no target has a verdict.
 *
 * @category constants
 * @since 0.1.0
 */
export const noRecordLabel = "(smthrs)"

/**
 * Why `smthrs ci` wrote no run record, from what it printed: the `message`
 * of its error, else its last line.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const whyNoRecord = (output: string): string => {
  const message = /^message: (.+)$/m.exec(output)?.[1]
  const last = output.split("\n").findLast((line) => line.trim() !== "")
  return firstLine(message ?? last ?? "") || "smthrs ci wrote no run record"
}

/**
 * The one result of a run that has no run record.
 *
 * @throws {never}
 * @category constructors
 * @since 0.1.0
 */
export const noRecord = (output: string): TargetResult => ({
  label: noRecordLabel,
  status: "failed",
  key: "",
  durationMs: 0,
  error: whyNoRecord(output)
})

const failedLimit = 5

const whyOf = (result: TargetResult): ReadonlyArray<string> => failuresOf([result]).map(sentenceOf)

/**
 * What one mode of one commit did, for standard error: its counts and time,
 * then the first failed targets with their reasons, then the targets that
 * failed and passed when run again.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const linesOf = (
  at: string,
  results: ReadonlyArray<TargetResult>,
  wallMs: number
): ReadonlyArray<string> => {
  const count = (status: TargetResult["status"]): number => results.filter((result) => result.status === status).length
  const failed = results.filter((result) => result.status === "failed")
  const flaky = results.filter((result) => verdictOf(result) === "flaky")
  const more = failed.length - failedLimit
  return [
    `${at}: ${count("ran")} ran, ${count("hit")} from the cache, ${failed.length} failed, ${
      count("skipped")
    } skipped in ${Math.round(wallMs / 1000)} s`,
    ...failed.slice(0, failedLimit).flatMap(whyOf).map((why) => `${at}: ${why}`),
    ...(more > 0 ? [`${at}: and ${more} more failed`] : []),
    ...flaky.slice(0, failedLimit).map((result) => `${at}: ${result.label} failed, then passed when run again`)
  ]
}

/**
 * The targets that ran although nothing they read changed: each ran and
 * passed with the key it passed with at an earlier commit, kept in
 * `passedWith` by label. The cache was there and did not serve them, so no
 * cache makes them faster as the build stands.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const ranAgain = (
  passedWith: ReadonlyMap<string, string>,
  results: ReadonlyArray<TargetResult>
): ReadonlyArray<string> =>
  results
    .filter((result) => result.status === "ran" && result.key !== "" && passedWith.get(result.label) === result.key)
    .map((result) => result.label)

/**
 * The line for {@link ranAgain}'s targets, or none when there is none. It
 * says what was seen and no more: why a target is not served from the cache
 * is for its owner to find.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const ranAgainLines = (at: string, labels: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (labels.length === 0) return []
  const more = labels.length - failedLimit
  return [
    `${at}: ${labels.length} ran again though ${labels.length === 1 ? "its key" : "their keys"} did not change: ${
      labels.slice(0, failedLimit).join(" ")
    }${more > 0 ? ` +${more}` : ""}`
  ]
}
