/**
 * Prompt optimization against a fixed evaluation suite.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as CaseExecutor from "./CaseExecutor.ts"
import { EvalError } from "./EvalError.ts"
import * as Runner from "./Runner.ts"
import type { Suite } from "./Suite.ts"

/**
 * One evaluated prompt and its suite result.
 *
 * @category models
 * @since 0.1.0
 */
export interface CandidateAttempt {
  readonly iteration: number
  readonly prompt: string
  readonly score: number
  readonly run: Runner.RunResult
}

/**
 * State available to the proposer after a completed iteration.
 *
 * @category models
 * @since 0.1.0
 */
export interface ProposeContext {
  readonly bestPrompt: string
  readonly bestScore: number
  readonly currentPrompt: string
  readonly currentScore: number
  readonly currentRun: Runner.RunResult
  readonly history: ReadonlyArray<CandidateAttempt>
  readonly iteration: number
}

/**
 * Evaluation, proposal, and stopping policy for prompt optimization.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options<E = never, R = never> {
  readonly suite: Suite
  readonly initialPrompt: string
  readonly evaluatePrompt: (prompt: string) => CaseExecutor.Service
  readonly propose: (context: ProposeContext) => Effect.Effect<string, E, R>
  readonly maxIterations: number
  readonly targetScore?: number | undefined
  readonly onMaxReached?: "return-best" | "fail" | undefined
  readonly runIdPrefix: string
  readonly at: string
}

/**
 * Best candidate and chronological history when optimization completes.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result {
  readonly _tag: "Converged" | "Exhausted"
  readonly bestPrompt: string
  readonly bestScore: number
  readonly bestRun: Runner.RunResult
  readonly history: ReadonlyArray<CandidateAttempt>
}

/**
 * Averages scored observations with equal weight. Returns undefined when no
 * observation has a score.
 *
 * @category scoring
 * @since 0.1.0
 */
export const meanScore = (run: Runner.RunResult): number | undefined => {
  let sum = 0
  let count = 0
  for (const observation of run.observations) {
    if (observation.kind === "score") {
      sum += observation.score
      count += 1
    }
  }
  return count === 0 ? undefined : sum / count
}

const invalidOption = (option: string, message: string): EvalError =>
  new EvalError({ code: "invalid_run_options", message, path: `options.${option}` })

/**
 * Evaluates prompts sequentially, starting at iteration one. The first
 * candidate at a given best score wins ties. A run with no scores fails,
 * and the default exhaustion policy returns the best candidate.
 *
 * @category runners
 * @since 0.1.0
 */
export const run = <E, R>(options: Options<E, R>): Effect.Effect<Result, EvalError | E, R> =>
  Effect.gen(function*() {
    const { at, initialPrompt, maxIterations, onMaxReached, runIdPrefix, suite, targetScore } = options
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
      return yield* invalidOption("maxIterations", "maxIterations must be a positive safe integer")
    }
    if (targetScore !== undefined && (!Number.isFinite(targetScore) || targetScore < 0 || targetScore > 1)) {
      return yield* invalidOption("targetScore", "targetScore must be finite and between 0 and 1")
    }
    if (onMaxReached !== undefined && onMaxReached !== "return-best" && onMaxReached !== "fail") {
      return yield* invalidOption("onMaxReached", "onMaxReached must be 'return-best' or 'fail'")
    }
    if (onMaxReached === "fail" && targetScore === undefined) {
      return yield* invalidOption("onMaxReached", "onMaxReached 'fail' requires a targetScore")
    }
    if (initialPrompt.trim().length === 0) {
      return yield* invalidOption("initialPrompt", "initialPrompt must be non-empty")
    }
    if (runIdPrefix.trim().length === 0) {
      return yield* invalidOption("runIdPrefix", "runIdPrefix must be non-empty")
    }

    const history: Array<CandidateAttempt> = []
    let prompt = initialPrompt
    let best: CandidateAttempt | undefined
    for (let iteration = 1;; iteration++) {
      const currentRun = yield* Runner.run(suite, { runId: `${runIdPrefix}-${iteration}`, at }).pipe(
        Effect.provide(Layer.succeed(CaseExecutor.CaseExecutor)(options.evaluatePrompt(prompt)))
      )
      const score = meanScore(currentRun)
      if (score === undefined) {
        return yield* new EvalError({
          code: "no_scores",
          message: `Iteration ${iteration} produced no scored observations`
        })
      }

      const attempt = { iteration, prompt, score, run: currentRun }
      history.push(attempt)
      if (best === undefined || score > best.score) best = attempt

      const converged = targetScore !== undefined && score >= targetScore
      if (converged || iteration === maxIterations) {
        if (!converged && onMaxReached === "fail") {
          return yield* new EvalError({
            code: "target_not_reached",
            message: `Best score ${best.score} fell short of targetScore ${targetScore} after ${iteration} iterations`
          })
        }
        return {
          _tag: converged ? "Converged" : "Exhausted",
          bestPrompt: best.prompt,
          bestScore: best.score,
          bestRun: best.run,
          history
        }
      }

      prompt = yield* options.propose({
        bestPrompt: best.prompt,
        bestScore: best.score,
        currentPrompt: prompt,
        currentScore: score,
        currentRun,
        history: history.slice(),
        iteration
      })
    }
  })
