# Coding evidence in the existing run card

Coding requests reuse the existing run card. Predicted work, recorded outcomes, the retained prototype and Vibe progress are separate projections of recorded native evidence. The owning guide is `apps/app/docs/workbench-lanes/coding-plans.md`.

## Show predictions as predictions

The card shows a compact ordered list of predicted Changes before execution. Selecting a Change reveals its atomic commit messages, known native JJ change IDs, intent, predicted reads and writes, and planned fast, slow and delivery checks. These are predictions, not execution or passing-check claims. Planned null atomic IDs remain unassigned.

`/runs.coding.select RUN_ID CHANGE_ID` selects a Change through the same actor-tagged dispatcher for slash, button and agent doors. Selecting the current Change again collapses it. The selection persists as `run-trace.payload.codingChangeId`.

Manual runs retain their recorded `input.plan`. Prompt requests derive the latest `Plan` from a completed `coding/PreparePlan` or `coding/PrepareWithWiki` child. The renderer imports the recipe's actual `Plan` schema; there is no separate plan table. Missing, malformed, foreign or ambiguous evidence supplies no plan, and scrubbing backward cannot expose a later plan.

## Structured flow input

`flow.run` accepts an optional JSON object after its existing arguments, for example `/flow.run coding will/repo {"plan":{...}}`. Arrays, scalar inputs, malformed JSON and text after the object are refused. A malformed object stays on the form with its parse error. The registered descriptor is `coding`; the internal tag `coding/ImplementPlan` is not the name to pass.

## Separate outcomes from execution status

The actual `coding/CorrectPlan` output, or its enclosing `coding/Request` result, supplies validated, changes requested or blocked. An engine-completed parent alone is not validation. Recorded blocked child IDs link through the recursive trace and keep their source card's workspace binding.

While correction is active, an owned `coding/ObservePlan` or `coding/RepairPass` failure can supply a short review excerpt. **Inspect review feedback** selects that execution through `runs.trace.select`. It does not claim that repair started or validation passed.

## Retain the prototype for inspection

A completed owned `coding/Poc` child supplies the disposable prototype only when its result names the exact source in its recorded input. The card shows a short finding and complete before/after source as escaped text, never executing retained HTML. The `runs.steer` form submits feedback; a queued receipt does not prove a revised plan.

## Vibe invitation and progress

**Vibe this change** appears only when the current `coding/Request` result validates, its plan matches, its recorded ancestry is coherent, and the source gateway's recorded catalog includes `coding/vibe`. Without that catalog, **Check available flows** runs `flow.list`. Both `flow.list` and `flow.run` accept an optional `sourceCard` that keeps the originating workspace.

`CodingVibeProgress` is a render-only structure derived from completed `coding/AdmitVibe` and `coding/CleanVibeHistory` receipts, with `original-retained` and `cleaned-retained` stages for source retention. None of these stages claims append, landing or shipment. Its Inspect button opens the exact native child in the existing debugger.

## Test boundary

Chromium tests use retained native host evidence and separate synthetic layout fixtures. The browser fixture is not a live coding canary.
