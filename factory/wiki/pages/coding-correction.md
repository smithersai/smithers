# Repair the earliest owning Change

`CorrectPlan` is an opt-in repository recipe in `correction.ts`. It does not change `coding/ImplementPlan`, register a gateway capability or create a coding ledger; a host composes it with the existing coding, agent, native JJ, executable catalog and check layers.

## Bound the correction loop

`maxRounds` counts validation passes, including the first implementation pass, and must be one through eight. A validated result stops immediately. At the bound, unresolved findings return `changes-requested`. Each round uses the existing durable trampoline and each pass is a recorded child execution.

Every unvalidated pass before the last feeds `@smthrs/flow`'s `Stall` with each atom's JJ tree id, the failing check receipts and the findings the next repair would receive. The default policy `{ rounds: 2, on: "park" }` ends correction when two passes in a row show the same signal: `park` returns `blocked`, `stop` returns `changes-requested`, and `escalate` fails with `stalled`.

## Stop early on actionable feedback

The first pass uses `ObservePlan`. Each fast-gated implementation and validated slow-check receipt is recorded in the native `DurableDeferred` store. Once every planned implementation exists and feedback is actionable, a typed `EarlyFeedback` outcome stops the pass before unrelated slow checks finish. An implementation or fast-gate failure ends the pass directly.

Before continuing, correction requests cancellation and requires terminal states for the pass and its descendants; a cancellation request alone is insufficient. Without acknowledgement within 300 observations 100 ms apart, it returns blocked evidence.

## Repair the owner in place

Correction chooses the earliest owning Change among completed receipts. An `AgentAction` selects one existing atom in that Change; the configured host wraps it with `evidenceOnly`, and standalone compositions must supply equivalent authority. A deterministic action rejects an unknown or foreign atom. The implementation delegate edits that atom in place, preserving its JJ change ID.

Before and after editing, the recipe re-reads the base and every known atom, refuses changed code, missing IDs or conflicts, and requires one linear native parent chain. It restores the known tip with a prepared native request and refuses an intervening operation instead of refreshing its fence.

## Recheck rewritten source

Only an exactly unchanged implementation keeps its old receipts; rewritten source gets fresh revision references and is measured again. Missing checks run even when other checks for that Change passed. Final assessment requires every configured receipt and validates source commits and finding ownership.

## Read the outcome

`CorrectionResult.status` is `validated`, `changes-requested` or `blocked`. An execution failure returns `blocked` with the failed pass's native execution ID. The parent flow completes with that outcome while the failed child keeps its failed status, so a completed run alone does not mean the code is validated. Cancellation remains cancellation.
