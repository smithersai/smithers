# Predicted coding Changes in a run

Updated 2026-09-09. Owner: `apps/ui`. Recipe contract: `flows/coding/schema.ts`.

The existing run card shows a compact ordered list of predicted Changes before
execution. Selecting a Change reveals its atomic commit messages, existing native
JJ change IDs where known, intent, predicted reads/writes, and planned fast, slow
and delivery checks. These are predictions, not execution or passing-check claims.
The ordinary turn narrative and recorded debugger detail remain in the same card.

The current shell opens full-screen content. Command-K / Control-K opens only
the bottom composer dock; Escape dismisses the dock. Chat history and embedded
run cards occupy the workspace above it. See `../ONBOARDING.md`.

## Existing app API extension: structured flow input

`flow.run` now accepts an optional JSON object after its existing arguments:

```text
/flow.run check will/repo {"target":"//ui:typecheck"}
/flow.run coding will/repo {"plan":{...}}
```

The second line shows the envelope, not a complete executable plan. Its `plan`
must satisfy the repository recipe's `Plan` schema and validation rules.
Existing `flow.run <name>` and `flow.run <name> <owner/repo>` invocations still
launch with `{}`. Omitting the repository retains the existing repository
selection rules. Nested values and whitespace inside JSON strings are preserved;
arrays, scalar inputs, malformed JSON, and text after the object are refused.

The app flow's input is now
`{name: string, repo?: string, input?: Record<string, Json>, sourceCard?: string}`. The existing form
derives an Input JSON field from that schema. A malformed object remains on the
form with its parse error and cannot launch until corrected. This also fixes the
form's existing text conversion for an object value: it displays JSON instead of
`[object Object]`. No new field kind or form framework was added.
Form edits replace the existing card payload so clearing an optional parse error
persists correctly; the form's authorization continuation remains unchanged.

The controller forwards the object through the existing workflow launch:

```ts
await controller.runWorkflow("coding", "will/repo", { plan })
```

This is an extension to an existing app controller method, not a public package
API. Provisioning, launch capability checks, gateway Plan/Run procedures,
idempotency, and the run card all use their established paths. The registered
repository descriptor is `coding`; its internal delegate tag `coding/RunPlan`
is not the name to pass to `flow.run`.

## New app flow and internal state

```text
/runs.coding.select RUN_ID CHANGE_ID
```

The typed input is `{runId: string, changeId: string, sourceCard?: string}`. Slash, button and agent
doors use the same actor-tagged dispatcher. Selecting the current Change again
collapses it. A missing Change or run is refused; missing input uses the existing
schema-derived form. Native button semantics provide Tab, Enter and Space
operation with a visible focus outline.

The optional persisted presentation field is `run-trace.payload.codingChangeId`.
Manual runs retain their recorded `input.plan`; prompt-based requests derive the
latest validated `Plan` value from an actual completed `coding/PreparePlan` or
`coding/PrepareWithWiki` child, even while implementation is still running.
Selection and reload use the same card state and native journal. The renderer
imports the recipe's actual Effect `Plan` schema and validation function. There
is no separate plan table or copied contract. Missing, malformed, foreign or
ambiguous native evidence supplies no invented plan.

## Evidence boundary

The host projects recorded native engine events into the existing control
journal. The card folds those records with the native codecs, checks recorded
child ownership and current execution generations, and respects its historical
cursor. A later prepared plan replaces the earlier one only after that child's
successful result is recorded; scrubbing backward cannot expose future plans.
Predicted reads, writes, atoms and checks remain predictions. Planned null atomic
IDs remain unassigned; the UI does not mint substitute change identities.

Actual `coding/CorrectPlan` output, or its enclosing `coding/Request` result,
supplies the separate domain outcome: validated, changes requested or blocked.
An engine-completed parent alone is not validation. A failed implementation
child can be intentional early feedback while its parent continues owner repair.
Recorded blocked child IDs link through the existing recursive trace and retain
their source card's workspace binding. Raw native results and receipts stay
available in debugger detail; none of these states imply vibed or shipped.

While correction remains active, an owned `coding/ObservePlan` or
`coding/RepairPass` failure can supply the separate compact review explanation.
The UI decodes the recipe's pure `EarlyFeedback` contract, checks the exact plan,
all planned implementation groups and finding owners, and requires a coherent
active `coding/CorrectPlan` ancestor. A short excerpt of the first recorded finding is visible;
**Inspect review feedback** selects that same execution through the existing
`runs.trace.select` flow. It does not open another card or claim that cancellation
has finished, repair has started, or validation has passed. The final correction
outcome supersedes this explanation. Historical cursors and newer execution
generations do not borrow it from another point in the run.

The internal render-only `EngineExecutionEvidence.failure` contains the original
classified failure kind, value and control sequence. It is derived from the
native result codecs; rendered error text is never reparsed into product facts.
`CodingEvidence.reviewFeedback` contains the decoded partial result and existing
span ID. These are projection structures, with no new stored field, flow, public
package API or state owner. Defects, mixed causes, unknown owners and malformed
feedback remain ordinary debugger evidence rather than review outcomes.

A completed owned `coding/Poc` child supplies the retained disposable prototype.
Its decoded result must name the exact source in its recorded input. The card
shows a short finding and disclosable complete before/after source as escaped
text, never executing retained HTML. Trace selection, keyboard-accessible source
scrolling and the existing actor-tagged `runs.steer` form provide inspection and
feedback. A queued feedback receipt does not itself prove a revised plan. No
agent turns, receipt statuses or synthetic execution events are manufactured by
the browser; the workspace reporter's `@` is not a complete history mirror.

## Design references and validation

[Graphite's stack review UI](https://graphite.com/docs/review-pull-requests)
keeps stack navigation beside the change being reviewed and provides keyboard
navigation. Here the compact Change list retains that context while one selected
Change exposes its predicted atoms and file ownership. The card's existing
turn/timeline inspection supplies recorded execution detail separately.

Focused tests cover typed launch and JSON form correction, actual recorded host
plan/POC results, cursor and generation boundaries, ambiguous ancestry refusal,
domain outcomes, actor-tagged selection and reload retention. Chromium tests
exercise the real flow/controller with retained native host evidence and separate
synthetic layout fixtures: Command-K, Tab, Enter/Space, source scrolling, feedback
submission, reload and maximization. The browser fixture is not a live coding
canary; the retained producer records came from the native host acceptance run.

Browser rendering is optimistic. The reload checks wait for the existing verbose
command-settlement trace before reloading OPFS; reloading an in-flight write can
restore the preceding selection. This slice does not add a global saved-state
indicator or change the app's persistence scheduling.

## Vibe invitation and recorded finalization

The completed request's existing outcome card offers **Vibe this change** only
when its current native `coding/Request` result validates, its plan matches the
visible outcome, and its completed descriptor bridge and approved wrapper have
coherent recorded ancestry. A completed `coding/CorrectPlan` alone does not
supply a request identity. Historical cursors, foreign ownership, missing
bridges, ambiguous generations and model prose cannot create the invitation.
The backend re-reads and validates the retained approval, POC and source before
admitting any finalization; the browser is a projection of that evidence.

The invitation also requires the exact source gateway's recorded executable
catalog to include the full `coding/vibe` flow. Repository FACTORY metadata or
an `AdmitVibe` child alone does not prove that capability. Without a matching
catalog, **Check available flows** uses the existing `flow.list` action to
refresh it. Both the listing and launch retain the originating workspace even
if the active repository changes. The server remains authoritative if the
catalog becomes stale.

**New app API parameters:** `flow.list` and `flow.run` now accept optional
`sourceCard`, through the same slash, button and agent doors:

```text
/flow.list sourceCard=completed-request-card
/flow.run sourceCard=completed-request-card coding/vibe {"requestExecutionId":"native-request-id"}
```

```ts
await controller.listWorkspaceWorkflows(undefined, "completed-request-card")
await controller.runWorkflow("coding/vibe", undefined,
  { requestExecutionId: "native-request-id" }, "completed-request-card")
```

The source must be an existing run card or a gateway-qualified workflow catalog.
An explicitly different repository, missing source, or old catalog without
binding provenance is refused. Omitting `sourceCard` keeps the existing active
repository rules. The existing gateway Plan, Approval.Submit and Run path is
unchanged. The caller supplies no successful result, source revision or plan.
The button's structured input uses `flowArgs`, and a partially specified launch
keeps its source through the existing form.

The existing `workflow-list` payload gains optional `workspaceId` and
`gatewayBindingVersion: 1`, matching run-card provenance. Bound catalog identities
include the workspace so two gateway databases for one repository cannot
overwrite each other's availability. Old catalogs still decode; their absent
provenance cannot prove Vibe availability. These are fields in the existing
cards collection, with no new store or synchronization mechanism.

`CodingVibeProgress` is a new render-only structure derived from completed native
`coding/AdmitVibe` and `coding/CleanVibeHistory` receipts using the recipe's pure
Effect schemas. It records stage, original request/control IDs, the existing
trace span and an optional short cleanup summary. Admission means the request
was admitted for cleanup; cleanup means descriptions and checks completed.
Neither receipt claims append, publication or shipment, and green parent output
cannot stand in for a child receipt. Its Inspect button opens the exact native
child in the existing debugger; full receipt text remains available there.


Original and cleaned source retention are separate completed facts in the same
progress projection. The browser uses the shared pure `PublicationInput` and
`SourcePublication` schemas. It checks the owning Vibe ancestry, input/source
identity, exact retained ref and the recorded workspace when available.
Original retention can appear while its matching `AdmitVibe` parent is still
running; it does not imply admission passed. Available admission and cleanup
receipts must agree with that original source. Cleaned retention requires the
actual validated cleanup receipt and its exact final source. A wrong parent,
workspace, source, phase or ref cannot create either fact.

The render-only `CodingVibeProgress` adds `original-retained` and
`cleaned-retained` stages plus an optional `sourceCommitId`. Its original control
run ID is optional until admission records it. Each stage keeps the existing
source-qualified child debugger link; a short commit prefix is only a visual
reference and never an execution identity. No API, collection or flow command
is added, and retention does not claim append, landing or shipment.
