/**
 * An offline completion judge for fixtures that record their commands.
 *
 * This deliberately limited script compares reported commands with the evidence
 * the brake received. It is not a general language judge and must never be a
 * production default. Whole-host fixtures with other classifiers must dispatch
 * those question ids too; flows/test/fixtures/scripted-judge.ts is the example.
 * Unknown questions fail closed rather than borrowing completion probabilities.
 *
 * @since 1.0.0-rc.0
 */
import * as CompletionClaim from "@smthrs/harness/CompletionClaim"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

const decodeEvidence = Schema.decodeUnknownResult(CompletionClaim.Evidence)

/** What this fixture answers to any question it does not script. The message is the transport's own so a journal line, a
 * refused check row and a test all read the same words. */
const unscripted = (detail: string): Evaluator.EvaluatorError =>
  new Evaluator.EvaluatorError({ code: "unreachable", message: `No evaluator is installed on this host (${detail})` })

/**
 * Whether one completion claim reports work this run's record does not record.
 *
 * This is the whole verdict the completion brake still acts on, so it is read
 * from the evidence rather than declared. A claim reports work when it both
 * speaks of a run or its outcome — `ran`, `passed`, `exits`, `output` — and
 * names something to run: a backticked span, or a runner and its arguments.
 * The record is every command in `checksRun` plus the completing frame's
 * `lastCheck`. A named command the record carries on either side of a
 * containment is recorded; one it carries nowhere is the refusal.
 *
 * A mention with no run or result around it is not a report. A proposed
 * fixture's `argv`, a path that happens to end in `.mjs`, or a cited file are
 * all things a run is entitled to write about work it has not done, and the
 * question this answers is deliberately narrower than "is the claim true".
 */
const reportsUnrecordedWork = (evidence: {
  readonly claim: string
  readonly checksRun: ReadonlyArray<{ readonly command: string }>
  readonly lastCheck?: { readonly command: string } | undefined
}): boolean => {
  const claim = evidence.claim
  if (
    !/\b(ran|run|runs|passed|passes|passing|failed|fails|executed|exited|exits|output|succeeded|green)\b/i.test(claim)
  ) {
    return false
  }
  const named = [
    ...[...claim.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!),
    ...[
      ...claim.matchAll(
        /\b(?:node|npm|pnpm|bun|yarn|python3?|cargo|make|jj|git|bash|sh|pytest|vitest|jest|tsc)\s+[^\n"'`,;)}\]]*/g
      )
    ]
      .map((match) => match[0])
  ].map((value) => value.trim()).filter((value) => value !== "" && !/^[\w*-]+:[\w*-]+:/.test(value))
  if (named.length === 0) return false
  const record = [
    ...evidence.checksRun.map((check) => check.command),
    ...(evidence.lastCheck ? [evidence.lastCheck.command] : [])
  ]
  return named.some((command) => !record.some((entry) => entry.includes(command) || command.includes(entry)))
}

/**
 * The completion brake's three answers, from one reading of one evidence
 * record.
 *
 * `invented` is the only one with a verdict behind it, and it is
 * {@link reportsUnrecordedWork}. `complete` and `overclaims` are bounce
 * heights that decide nothing — `CompletionClaim`'s own corpus demoted them
 * because neither separates an honest completion from a lie — so they are
 * answered consistently with the one reading rather than independently: a
 * claim that reports work nothing recorded is also a claim that overclaims and
 * has not shown the task done, and a claim that does not is neither. Answering
 * them at no demand keeps a fixture's measured model-call counts honest, since
 * a bounce spends a frame that a fixed script would answer with the same
 * sentence.
 */
const completion = (evidence: CompletionClaim.Evidence): Record<string, Evaluator.ScriptedAnswer> => {
  const unrecorded = reportsUnrecordedWork(evidence)
  return {
    complete: { probability: unrecorded ? 0.05 : 0.95 },
    overclaims: { probability: unrecorded ? 0.95 : 0.05 },
    invented: { probability: unrecorded ? 0.95 : 0.02 }
  }
}

/**
 * Deliberately bind this only in an offline fixture whose reported commands
 * use the syntax above. An unrecorded command changes the verdict; no answer
 * is an unconditional permission to complete.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer: Layer.Layer<Evaluator.Evaluator> = Evaluator.layerScripted((request) => {
  const ids = Object.keys(request.questions)
  if (ids.length !== 3 || !["complete", "overclaims", "invented"].every((id) => ids.includes(id))) {
    return Effect.fail(unscripted(`scripted completion judge has no answer for ${ids.sort().join(", ")}`))
  }
  const evidence = decodeEvidence(request.state)
  if (Result.isFailure(evidence)) {
    return Effect.fail(unscripted("scripted completion judge needs CompletionClaim.Evidence"))
  }
  return completion(evidence.success)
})
