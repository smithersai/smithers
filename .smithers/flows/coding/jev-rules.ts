/** The host judge answers a maintainer's rule one changed hunk at a time. */
import * as Classifier from "@smthrs/model/Classifier"
import { Schema } from "effect"
import { matchesGlob } from "node:path"
import { clip } from "./clip.ts"
import { CodingError } from "./schema.ts"

/** The change a rule is judged against: its unified diff, its changed paths,
 * and the captured texts a finding is cited onto. */
export interface RuleComparison {
  readonly diff: string
  readonly paths: ReadonlyArray<string>
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly changes: ReadonlyArray<
    { readonly path: string; readonly before: string | null; readonly after: string | null }
  >
}

/** The maintainer's rule and the path globs it covers. */
export interface RuleCheck {
  readonly id: string
  readonly name: string
  readonly rule: string
  readonly paths: ReadonlyArray<string>
}

/** What Jev decided about one rule, and where it found a violation. */
export interface RuleVerdict {
  readonly verdict: "pass" | "fail" | "uncertain"
  readonly summary: string
  readonly examinedPaths: ReadonlyArray<string>
  readonly findings: ReadonlyArray<{ readonly path: string; readonly line: number; readonly message: string }>
}

/** A hunk Jev is asked about: the candidate file, the first line the hunk
 * changes in the candidate, and the hunk's own unified diff text. `complete`
 * is false when the text was clipped to {@link MAX_HUNK_BYTES}, so Jev sees
 * only a prefix of the change and cannot clear the path. */
export interface Hunk {
  readonly path: string
  readonly line: number
  readonly hunk: string
  readonly complete: boolean
}

/** At or above this probability the hunk violates the rule and becomes a
 * finding. This is the review policy's decision threshold, not a calibrated
 * guarantee about whichever subscription model the host resolves. */
export const FLAG_PROBABILITY = 0.8
/** At or below this probability the hunk keeps the rule. Between the two
 * thresholds, the judge's uncertainty makes the check inconclusive. */
export const CLEAN_PROBABILITY = 0.2
/** The most bytes one hunk may take, matching `@smthrs/std`'s per-state bound. */
export const MAX_HUNK_BYTES = 32 * 1024
/** The most hunks one batched evaluation may carry, matching `@smthrs/std`. */
export const MAX_STATES = 64

/** Clips a hunk's text to {@link MAX_HUNK_BYTES} and records whether it stayed whole. */
export const bounded = (text: string): { readonly hunk: string; readonly complete: boolean } => {
  const hunk = clip(text, MAX_HUNK_BYTES)
  return { hunk, complete: hunk === text }
}

/** One boolean per (rule, hunk). The state is exactly what the rule can be
 * judged against, so a hunk that needs more than itself reads indecisive. */
export const ruleClassifier = Classifier.make("check/rule", {
  description: "Judge one changed hunk against one maintainer rule: does the hunk, as written, violate the rule?",
  state: Schema.Struct({
    rule: Schema.String.annotate({ description: "The maintainer's rule, in their own words" }),
    path: Schema.String.annotate({ description: "The changed file's path in the candidate" }),
    line: Schema.Int.annotate({ description: "The hunk's first changed line in the candidate" }),
    hunk: Schema.String.annotate({
      description: "The unified diff hunk, its @@ header included, kept under the 32 KiB the whole state may take. " +
        "A file's first hunk is led by its diff --git header and mode, rename or copy lines; " +
        "a file with no text change, such as a mode change, is that header alone"
    })
  }),
  questions: {
    violates: Classifier.boolean({
      instructions: "Does this hunk violate the rule as stated?",
      criteria: {
        true: "the changed lines break the rule as written, and the hunk itself shows the violation",
        false: "the changed lines keep the rule, or the rule does not apply to them"
      }
    })
  }
})

/** The state one hunk is judged as. */
export type RuleState = typeof ruleClassifier.state.Type

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const fileHeader = /^diff --git a\/(.+) b\/(.+)$/m

/** Every changed hunk of the candidate, in diff order.
 *
 * These are read from the same unified diff `diffPaths` already validated and
 * split on the same `diff --git` boundary, rather than re-derived from the
 * whole-file preimages in `changes`. `line` is the first line the hunk adds in
 * the candidate; a hunk that only deletes reports the candidate line the
 * deletion sits at. A path this parser reads is only ever judged when the
 * caller finds it in the check's scope ({@link scopedPaths}), so an encoding
 * the validated diff would have refused cannot reach a finding. */
export const hunks = (comparison: RuleComparison): ReadonlyArray<Hunk> => {
  const found: Array<Hunk> = []
  for (const part of comparison.diff.split(/(?=^diff --git )/m)) {
    const header = fileHeader.exec(part)
    if (!header) continue
    const path = header[2]!
    const lines = part.split("\n")
    for (let index = 0; index < lines.length; index++) {
      const start = hunkHeader.exec(lines[index]!)
      if (!start) continue
      const body = [lines[index]!]
      let candidate = Number(start[1]), first = 0
      for (index++; index < lines.length; index++) {
        const text = lines[index]!
        if (text.startsWith("@@") || text.startsWith("diff --git ")) break
        body.push(text)
        if (text.startsWith("+")) {
          if (!first) first = candidate
          candidate++
        } else if (text.startsWith(" ") || text === "") candidate++
      }
      index--
      found.push({ path, line: first || Math.max(1, Number(start[1])), ...bounded(body.join("\n")) })
    }
  }
  return found
}
/** The states of one evaluation, at most {@link MAX_STATES} each. */
export const batches = <A>(states: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const grouped: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < states.length; index += MAX_STATES) grouped.push(states.slice(index, index + MAX_STATES))
  return grouped
}

/** The changed paths this check is configured to cover, matched the way
 * `verifyTrialChecks` matches them. */
export const scopedPaths = (comparison: RuleComparison, check: RuleCheck): ReadonlyArray<string> =>
  comparison.paths.filter((path) => !check.paths.length || check.paths.some((pattern) => matchesGlob(path, pattern)))

/** A finding cites captured evidence or the check errors instead of failing,
 * so a line the hunk arithmetic put past the captured source is pulled back
 * onto it rather than thrown away, which would turn a fail into a pass. */
const cited = (comparison: RuleComparison, path: string, line: number): number => {
  const text = comparison.files.find((file) => file.path === path)?.text
    ?? comparison.changes.find((change) => change.path === path && change.after === null)?.before ?? undefined
  return text === undefined || text === null ? line : Math.min(line, Math.max(1, text.split("\n").length))
}

/** One answer per hunk becomes one verdict.
 *
 * A probability at or above {@link FLAG_PROBABILITY} flags the hunk, one at or
 * below {@link CLEAN_PROBABILITY} clears it, and anything between or a missing
 * answer is indecisive. Every answer decisive and none flagged is a pass, a
 * decisive flag is a fail, and one indecisive hunk makes the whole check
 * uncertain. A path in `partial` had a hunk Jev saw only a prefix of, so it is
 * never examined and, unless a hunk is flagged, the check is uncertain. An
 * evaluation Jev could not answer at all never reaches here: the caller fails
 * with {@link jevUnavailable} instead of inventing a verdict. */
export const jevVerdict = (
  comparison: RuleComparison,
  check: RuleCheck,
  states: ReadonlyArray<RuleState>,
  answers: ReadonlyArray<{ readonly violates: Classifier.BooleanAnswer }>,
  partial: ReadonlyArray<string> = []
): RuleVerdict => {
  const examinedPaths = scopedPaths(comparison, check).filter((path) => !partial.includes(path))
  const named = check.name || check.id
  if (!states.length) {
    return { verdict: "uncertain", summary: `Jev found no hunk to judge against ${named}`, examinedPaths, findings: [] }
  }
  const decided = states.map((_, index) => {
    const answer = answers[index]
    if (answer === undefined) return undefined
    const probability = answer.violates.probability
    return probability >= FLAG_PROBABILITY ? true : probability <= CLEAN_PROBABILITY ? false : undefined
  })
  const unsure = decided.filter((value) => value === undefined).length
  const flagged = states.filter((_, index) => decided[index] === true)
  if (unsure) {
    return {
      verdict: "uncertain",
      summary: `Jev was unsure about ${unsure} of ${states.length} hunks against ${named}`,
      examinedPaths,
      findings: []
    }
  }
  if (!flagged.length && partial.length) {
    return {
      verdict: "uncertain",
      summary: `Jev saw only part of the changes to ${partial.join(", ")} against ${named}`,
      examinedPaths,
      findings: []
    }
  }
  if (!flagged.length) {
    return { verdict: "pass", summary: `Jev found no hunk violating ${named}`, examinedPaths, findings: [] }
  }
  return {
    verdict: "fail",
    summary: `Jev flagged ${flagged.length} of ${states.length} hunks against ${named}`,
    examinedPaths,
    findings: flagged.slice(0, 40).map((state) => ({
      path: state.path,
      line: cited(comparison, state.path, state.line),
      message: check.rule
    }))
  }
}

/** The typed failure a hunk Jev could not answer becomes. It names the
 * evaluator's own code and message so an errored check row says which part of
 * the transport gave out, not merely that something did. */
export const jevUnavailable = (check: RuleCheck, failure: Classifier.ClassifierError): CodingError =>
  new CodingError({
    code: "unavailable",
    message: `Jev could not judge ${check.name || check.id}: ${failure.code} — ${failure.message}`
  })
