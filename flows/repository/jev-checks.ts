/** Jev answers a maintainer's rule one changed hunk at a time, so the frontier
 * seat is asked only about the hunks Jev is not sure of. */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Redacted, Result, Schema } from "effect"
import { matchesGlob } from "node:path"
import type { Comparison, SemanticVerdict } from "./checks.ts"
import type { Check } from "./schema.ts"

/** A hunk Jev is asked about: the candidate file, the first line the hunk
 * changes in the candidate, and the hunk's own unified diff text. */
export interface Hunk {
  readonly path: string
  readonly line: number
  readonly hunk: string
}

/** At or above this probability the hunk violates the rule and becomes a
 * finding. The vendor publishes no calibration curve, and the one agreement
 * figure it does publish is 76.0% against frontier reference labels on its
 * best-reported task (`docs/jev-harness/research.html`), so the band is wide
 * on purpose: an indecisive hunk costs one LLM call, while a wrong decisive
 * answer costs a wrong lint verdict on a maintainer's rule. */
export const FLAG_PROBABILITY = 0.8
/** At or below this probability the hunk keeps the rule. Same 76.0% reasoning
 * as {@link FLAG_PROBABILITY}: anything between the two thresholds is
 * indecisive and the seat decides it instead. */
export const CLEAN_PROBABILITY = 0.2
/** The most bytes one hunk may take, matching `@smthrs/std`'s per-state bound. */
export const MAX_HUNK_BYTES = 32 * 1024
/** The most hunks one batched evaluation may carry, matching `@smthrs/std`. */
export const MAX_STATES = 64

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const bounded = (text: string): string => {
  const bytes = encoder.encode(text)
  return bytes.length <= MAX_HUNK_BYTES ? text : decoder.decode(bytes.slice(0, MAX_HUNK_BYTES))
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
      description: "The unified diff hunk, its @@ header included, kept under the 32 KiB the whole state may take"
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
 * deletion sits at. A path this parser reads is only ever judged when
 * `jevSemanticCheck` finds it in the check's scope, so an encoding the
 * validated diff would have refused cannot reach a finding. */
export const hunks = (comparison: typeof Comparison.Type): ReadonlyArray<Hunk> => {
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
      found.push({ path, line: first || Math.max(1, Number(start[1])), hunk: bounded(body.join("\n")) })
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
export const scopedPaths = (comparison: typeof Comparison.Type, check: typeof Check.Type): ReadonlyArray<string> =>
  comparison.paths.filter(path => !check.paths.length || check.paths.some(pattern => matchesGlob(path, pattern)))

/** A finding cites captured evidence or the check errors instead of failing,
 * so a line the hunk arithmetic put past the captured source is pulled back
 * onto it rather than thrown away, which would turn a fail into a pass. */
const cited = (comparison: typeof Comparison.Type, path: string, line: number): number => {
  const text = comparison.files.find(file => file.path === path)?.text
    ?? comparison.changes.find(change => change.path === path && change.after === null)?.before ?? undefined
  return text === undefined || text === null ? line : Math.min(line, Math.max(1, text.split("\n").length))
}

/** One answer per hunk becomes one verdict.
 *
 * A probability at or above {@link FLAG_PROBABILITY} flags the hunk, one at or
 * below {@link CLEAN_PROBABILITY} clears it, and anything between, a missing
 * answer or a refused evaluation is indecisive. Every answer decisive and none
 * flagged is a pass, a decisive flag is a fail, and one indecisive hunk makes
 * the whole check uncertain, which is the only outcome that spends the seat. */
export const jevVerdict = (
  comparison: typeof Comparison.Type,
  check: typeof Check.Type,
  states: ReadonlyArray<RuleState>,
  answers: ReadonlyArray<Result.Result<{ readonly violates: Classifier.BooleanAnswer }, Classifier.ClassifierError>>
): typeof SemanticVerdict.Type => {
  const examinedPaths = scopedPaths(comparison, check)
  const named = check.name || check.id
  if (!states.length) {
    return { verdict: "uncertain", summary: `Jev found no hunk to judge against ${named}`, examinedPaths, findings: [] }
  }
  const decided = states.map((_, index) => {
    const answer = answers[index]
    if (answer === undefined || Result.isFailure(answer)) return undefined
    const probability = answer.success.violates.probability
    return probability >= FLAG_PROBABILITY ? true : probability <= CLEAN_PROBABILITY ? false : undefined
  })
  const unsure = decided.filter(value => value === undefined).length
  const flagged = states.filter((_, index) => decided[index] === true)
  if (unsure) {
    return { verdict: "uncertain", summary: `Jev was unsure about ${unsure} of ${states.length} hunks against ${named}`,
      examinedPaths, findings: [] }
  }
  if (!flagged.length) {
    return { verdict: "pass", summary: `Jev found no hunk violating ${named}`, examinedPaths, findings: [] }
  }
  return { verdict: "fail", summary: `Jev flagged ${flagged.length} of ${states.length} hunks against ${named}`, examinedPaths,
    findings: flagged.slice(0, 40).map(state => ({ path: state.path, line: cited(comparison, state.path, state.line), message: check.rule })) }
}

/** Asks Jev about every in-scope hunk and reports what it decided.
 *
 * The call never fails: a host with no transport, a refused gateway and a
 * malformed answer all read as indecisive, which sends the check to the seat
 * exactly as an indecisive answer does. */
export const jevSemanticCheck = (
  comparison: typeof Comparison.Type,
  check: typeof Check.Type
): Effect.Effect<typeof SemanticVerdict.Type, never, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const scoped = new Set(scopedPaths(comparison, check))
    const rule = check.rule.trim()
    const states: ReadonlyArray<RuleState> = !rule ? []
      : hunks(comparison).filter(hunk => scoped.has(hunk.path)).map(hunk => ({ rule, ...hunk }))
    if (!states.length) return jevVerdict(comparison, check, [], [])
    const answered = yield* Effect.forEach(batches(states), batch => ruleClassifier.evaluateAll(batch), { concurrency: 1 })
    return jevVerdict(comparison, check, states, answered.flat())
  })

/** The evaluator a repository check host runs with: Jev through the Vercel
 * gateway when `AI_GATEWAY_API_KEY` is set, else one that answers
 * `unreachable`, so without a key every hunk is indecisive and the seat keeps
 * deciding every AI check exactly as it did before. */
export const evaluatorLayer = (
  environment: Readonly<Record<string, string | undefined>>
): Layer.Layer<Evaluator.Evaluator> => {
  const key = environment["AI_GATEWAY_API_KEY"]
  return key === undefined || key === ""
    ? Evaluator.layerUnavailable()
    : Evaluator.layerVercelGateway({ apiKey: Redacted.make(key) }).pipe(Layer.provide(NodeHttpClient.layerUndici))
}
