/**
 * What a replay of a repository's own targets says about one run: the reason
 * each failed target gave, a line per run for the person waiting, and the
 * refusal when nothing passes on this machine.
 *
 * @since 0.1.0
 */

import { type RunRecord, type TargetResult, verdictOf } from "../contract/RunRecord.ts"

const reasonLimit = 200

/**
 * The first line of a text that says something, without control characters,
 * cut at 200 characters.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const firstLine = (text: string): string => {
  const line = text.split("\n").map((entry) => entry.replace(/\p{Cc}/gu, " ").trim()).find((entry) => entry !== "")
  return (line ?? "").slice(0, reasonLimit)
}

/**
 * The reason `smthrs` printed for each failed target, by label. Its plain
 * output has one line per failure: the label, `failed`, the time, the reason.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const reasonsIn = (output: string): ReadonlyMap<string, string> =>
  new Map(
    [...output.matchAll(/^(\/\/\S+) +failed +\S+ +(.+)$/gm)].map((match) => [match[1] as string, match[2] as string])
  )

/**
 * The results with the reason `smthrs` printed added to each failed target
 * whose record has none. An older `smthrs` writes no reason in its run record.
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
      ? { ...result, error: reason }
      : result
  })
}

const failedLimit = 5

const whyOf = (result: TargetResult): string =>
  `${result.label} failed: ${firstLine(result.error ?? "") || "smthrs gave no reason"}`

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
    ...failed.slice(0, failedLimit).map((result) => `${at}: ${whyOf(result)}`),
    ...(more > 0 ? [`${at}: and ${more} more failed`] : []),
    ...flaky.slice(0, failedLimit).map((result) => `${at}: ${result.label} failed, then passed when run again`)
  ]
}

/**
 * Why there is nothing to report, or `undefined` when a target passed in a
 * baseline. With no pass at any commit the build does not run on this
 * machine: the reason is the newest commit's first failure.
 *
 * @throws {never}
 * @category accessors
 * @since 0.1.0
 */
export const nothingPassed = (baselines: ReadonlyArray<RunRecord>): string | undefined => {
  const passed = baselines.some((record) =>
    record.results.some((result) => result.status !== "failed" && result.status !== "skipped")
  )
  const newest = baselines.at(-1)
  if (passed || newest === undefined) return undefined
  const failed = newest.results.find((result) => result.status === "failed")
  const commits = `${baselines.length} replayed commit${baselines.length === 1 ? "" : "s"}`
  const at = (newest.commit ?? "").slice(0, 7)
  return `no target passed at any of the ${commits}. At ${at}, ${
    failed === undefined ? "the patterns selected no target that ran" : whyOf(failed)
  }`
}
