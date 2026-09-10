# Repair the earliest owning Change

The private `CorrectPlan` flow composes the existing native coding, agent, check and runtime services. Its configured host supplies these layers.

## Bound the correction loop

`maxRounds` is one through eight and counts the initial implementation pass. A validated result stops the loop. Exhausting the bound with unresolved findings returns `changes-requested`. Execution failures return a typed `blocked` outcome with the failed child execution ID and any previous result. Cancellation stays cancellation. The parent completing its procedure does not mean its domain outcome is validated.

The first pass uses `ObservePlan`. Its native deferred results retain finished implementations and actionable check evidence. When the implementation branch has finished and a valid finding exists, early feedback can end observation before unrelated slow checks finish. Correction requests cancellation and requires bounded terminal acknowledgement before continuing; a cancellation request alone is insufficient. A failed implementation or required fast gate ends its pass directly.

## Preserve native ownership

Repair selects an atom belonging to the earliest Change with findings. The configured host wraps the selection agent in `evidenceOnly`; standalone compositions must supply their own authority. The implementation delegate edits the selected native JJ atom. It does not allocate a replacement identity for that atom.

Before and after mutation, the recipe reads the known native IDs and checks their commit, tree and parent identities. It rejects an altered prefix, conflicts, missing ownership or a broken linear chain. It restores the known tip using a prepared native request and refuses an intervening operation instead of silently refreshing that fence. Its host must coordinate exclusive editing.

## Recheck changed evidence

An exactly unchanged implementation can retain matching individual receipts. Rewritten source receives fresh revision references and new checks. A missing check is still required even if another check for the same Change passed. Fast checks gate the next Change; slow checks can overlap subsequent work. Final assessment validates every required receipt, its exact input digest and finding ownership.

The native fixture contains assertions for bounded correction, unchanged-prefix receipt reuse, rewritten checks, a refused foreign atom, cancelled checker cleanup and cold-host replay. These are executable test definitions, not evidence that a particular test run or deployment passed. The configured request flow composes planning and disposable POC feedback with correction.
