# Planning from current repository evidence

`PreparePlan` is a private repository recipe composed from ordinary `Flow`, `Action`, `AgentAction` and `HumanTask`. It returns the existing coding `Plan`; it does not execute that plan or create another storage service. Its observations, model results, question, answer and final plan persist in the existing flow journal and database.

## Gather evidence

`GatherContext` snapshots current bytes through the configured native `Jj` service, reads a bounded linear native history, and reads request paths and existing repository documents within source byte and path bounds. Generated Wiki memory is empty by default.

A stack request carries the stack's published wiki pages; gather keeps only pages whose inputs still hash to the current source. With the operator's `wiki: true`, the Wiki verifier checks the host's snapshot for freshness, publication integrity and recorded semantic review. A missing or stale wiki never refuses gather; planning proceeds without it. Selected pages keep explicit `current` or `intent` labels.

`PlanningContext` is durable action input/output, not a database table. It holds the native head and history, selected memory, bounded source text with digests, paths that were missing, verified implementation/check definitions and a canonical `memoryRevision`.

## Clarify or decline

`ReviewRequest` explains material constraints and either proceeds or emits one bundled clarification. A nonempty question calls the existing durable `HumanTask`, and a restarted host can answer that same token. When the request is not actionable, the review's `decline` fails the plan with `CodingError{code:"declined"}` and nothing is drafted.

## Draft and finalize

`DraftPlan` chooses native atoms, predicts reads and writes, and selects implementation/check names only from measured host catalog entries. An existing atom uses its full JJ change ID; a new atom uses `null` until JJ creates it.

`VerifyContext` captures current bytes again after any human wait and model draft, verifies every gathered native identity, and refuses a result whose code changed while planning. `FinalizePlan` binds the choices to the verified executable digests, memory identity, native base and `observedHead`. Every operator-required check is included on every Change, and each Change needs a required fast and a required slow check. Omitted or reordered descendants, duplicate ownership, unknown checks and escaping paths are refused.

## Enforce evidence-only authority

The configured host applies `evidenceOnly` to `coding/review-request` and `coding/draft-plan` at action execution, after native authority restoration. It supplies an empty callable catalog and capability ceiling while keeping budgets, steering and model routing. These roles also run with `unmovedCap: 0`, so a planning answer need not change workspace files. The prompt is not the security boundary.
