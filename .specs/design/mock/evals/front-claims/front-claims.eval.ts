/**
 * README — Front claims guard, every existing mock dist (2026-10-18).
 * From the workspace root (CLI discovery is scoped to <root>/evals):
 *   smthrs eval run evals/front-claims/front-claims.eval.ts --root .specs/design/mock
 * MOCK_DISTS overrides the six default directories with a comma-separated list
 * of absolute dist paths. Defaults scan the mock root and the delivered copy (scoring.ts deliveredRoot);
 * newest index.html wins per dist (delivered copy wins ties). Only existing directories become cases.
 * banned-claims, required-copy and static-first-screen each score 0 or 1.
 * Reads index.html only; no browser, model, network or new dependencies.
 * Offline commands: see front-claims.test.ts. Missing index.html fails execution.
 */
import { Effect } from "effect"
import * as CaseExecutor from "../../../../../packages/smithers/agent/evals/src/CaseExecutor.ts"
import * as Suite from "../../../../../packages/smithers/agent/evals/src/Suite.vibe"
import * as Binding from "../../../../../packages/smithers/agent/scorers/src/Binding.ts"
import * as Scorer from "../../../../../packages/smithers/agent/scorers/src/Scorer.ts"
import { discoverDists, readDist, scorers, bannedClaims, type Output } from "./scoring.ts"
const target = { name: "evals/front-claims/dist" }
export const makeScorers = () => Object.entries(scorers).map(([name, score]) => Scorer.make({
  id: `evals/front-claims/${name}`, version: "1", name, config: { bannedClaims },
  score: ({ output }) => Effect.sync(() => score(output as Output))
}))
export const suite = Suite.make({
  name: "front-claims", concurrency: 1,
  cases: discoverDists().map(dist => ({ name: dist, input: { dist } })),
  bindings: makeScorers().map(scorer => Binding.make({ scorer, appliesTo: target }))
})
export const executor = CaseExecutor.make(entry => Effect.sync(() => {
  const started = performance.now()
  const output = readDist((entry.input as { dist: string }).dist)
  return { output, target, stepKey: `front-claims/${entry.name}`, latencyMs: performance.now() - started }
}))
export default { suite, executor }
