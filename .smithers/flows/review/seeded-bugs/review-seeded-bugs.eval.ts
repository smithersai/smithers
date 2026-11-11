/** Offline seeded-review fixture suite for the fixed-suite CLI. */
import { CaseExecutor, EvalError, Suite } from "@smthrs/evals"
import { Effect } from "effect"
import { layerMemory } from "./host.ts"
import * as Binding from "../../../../packages/smithers/agent/scorers/src/Binding.ts"
import * as Scorer from "../../../../packages/smithers/agent/scorers/src/Scorer.ts"
import { answerReview } from "./deterministicReviewer.ts"
import { loadCorpus } from "./labels.ts"
import { runFixture } from "./run.ts"
import { scoreCorpus, type ReviewFinding } from "./score.ts"
import { scriptedSeats } from "./scriptedSeats.ts"

const target = { name: "evals/review-seeded-bugs/fixture" }
const labels = loadCorpus()
const scorer = Scorer.make({
  id: "evals/review-seeded-bugs/f1",
  version: "1",
  name: "review-seeded-bugs/f1",
  score: ({ output, groundTruth }) => Effect.sync(() =>
    ({ score: scoreCorpus([groundTruth as (typeof labels)[number]], {
      [(groundTruth as (typeof labels)[number]).fixture]: output as ReviewFinding[]
    }).f1 })
  )
})

export const suite = Suite.make({
  name: "review-seeded-bugs",
  concurrency: 1,
  cases: labels.map((label) => ({
    name: label.fixture,
    input: label.fixture,
    expected: label
  })),
  bindings: [Binding.make({ scorer, appliesTo: target })]
})

/**
 * Builds the executor over a review host.
 *
 * Only a review that reviewed something has findings to score. A review that
 * ended `failed` (every file review failed) or `skipped` (no file was
 * reviewed) ends with no comments, which is also what a finished clean review
 * looks like: scored, a clean control would earn the perfect score and a
 * planted bug the run already missed would keep its zero, and the lost
 * execution would never show. Such a case fails with an `executor` error
 * instead, so the run records it as a failure.
 */
export const makeExecutor = (layer: ReturnType<typeof layerMemory>): CaseExecutor.Service =>
  CaseExecutor.make((entry) =>
    Effect.promise(async () => {
      const label = labels.find((item) => item.fixture === entry.input)
      if (label === undefined) throw new Error(`Unknown fixture: ${entry.input}`)
      return { label, review: await runFixture(label, layer) }
    }).pipe(
      Effect.flatMap(({ label, review }) =>
        review.status === "failed" || review.status === "skipped"
          ? Effect.fail(
            new EvalError.EvalError({
              code: "executor",
              message: `Review of fixture '${label.fixture}' ended ${review.status}: nothing was reviewed, so there are no findings to score`
            })
          )
          : Effect.succeed({
            output: review.findings,
            stepKey: `review-seeded-bugs/${label.fixture}`,
            latencyMs: 0,
            target
          })
      )
    )
  )

/** The offline executor: the deterministic reviewer over the in-memory host. */
export const executor: CaseExecutor.Service = makeExecutor(layerMemory(scriptedSeats(answerReview), {}))

export default { suite, executor }
