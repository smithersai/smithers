/** The repository pack's semantic check: Jev judges a maintainer's rule one changed hunk at a time. */
import type * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Result } from "effect"
import {
  batches,
  bounded,
  type Hunk,
  hunks,
  jevUnavailable,
  jevVerdict,
  ruleClassifier,
  type RuleState,
  scopedPaths
} from "../coding/jev-rules.ts"
import type { CodingError } from "../coding/schema.ts"
import type { Comparison, SemanticVerdict } from "./checks.ts"
import type { Check } from "./schema.ts"

/** Every changed path of a proposal, as one whole-file replacement hunk.
 *
 * A proposal is checked before it is a commit, so `captureChecks` gives its
 * comparison no unified diff at all — the change is carried in `changes`, each
 * entry holding the exact preimage and the exact proposed text. While a
 * frontier seat existed that gap was invisible: Jev answered `uncertain` on
 * every proposal and the seat read `changes` itself. With Jev the only
 * checker, a proposal with no state would make every produced change's
 * required review uncertain, so the change is rendered as the unified hunk it
 * will become. `line` is 1 because the hunk covers the file from its first
 * line, and `cited` pulls a finding back onto the captured text. */
export const proposalHunks = (comparison: typeof Comparison.Type): ReadonlyArray<Hunk> =>
  comparison.changes.map((change) => {
    const before = change.before === null ? [] : change.before.replace(/\n$/, "").split("\n")
    const after = change.after === null ? [] : change.after.replace(/\n$/, "").split("\n")
    const header = `@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@`
    return {
      path: change.path,
      line: 1,
      ...bounded([header, ...before.map((text) => `-${text}`), ...after.map((text) => `+${text}`)].join("\n"))
    }
  })
/** Asks Jev about every in-scope hunk and reports what it decided.
 *
 * Jev is the only model that judges the rule. A host with no transport, a
 * refused provider, a timeout and a malformed answer all fail the call with
 * {@link jevUnavailable}; nothing else is asked and no verdict is invented.
 * An indecisive answer is different: that is Jev deciding it is unsure, and
 * the uncertain verdict it produces is the check's own verdict. */
export const jevSemanticCheck = (
  comparison: typeof Comparison.Type,
  check: typeof Check.Type
): Effect.Effect<typeof SemanticVerdict.Type, CodingError, Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const scoped = new Set(scopedPaths(comparison, check))
    const rule = check.rule.trim()
    // A committed comparison carries its own diff. A proposal carries none,
    // so its exact changes are rendered as hunks instead.
    const parsed = hunks(comparison)
    const changed = parsed.length ? parsed : proposalHunks(comparison)
    const judged = rule ? changed.filter((hunk) => scoped.has(hunk.path)) : []
    const states: ReadonlyArray<RuleState> = judged.map(({ hunk, line, path }) => ({ rule, path, line, hunk }))
    if (!states.length) return jevVerdict(comparison, check, [], [])
    const partial = [...new Set(judged.filter((hunk) => !hunk.complete).map((hunk) => hunk.path))]
    const answered = yield* Effect.forEach(batches(states), (batch) => ruleClassifier.evaluateAll(batch), {
      concurrency: 1
    })
    const answers: Array<{ readonly violates: Classifier.BooleanAnswer }> = []
    for (const answer of answered.flat()) {
      if (Result.isFailure(answer)) return yield* Effect.fail(jevUnavailable(check, answer.failure))
      answers.push(answer.success)
    }
    return jevVerdict(comparison, check, states, answers, partial)
  })
