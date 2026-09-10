# Read coding evidence in the existing run card

The coding UI extends the existing card, frame history, actor-tagged dispatcher and TanStack DB state. The default run presentation combines compact recorded turns with selected recursive execution detail. Coding-specific projections decode the private recipe's actual schemas instead of copying a Plan or result contract into another store.

## Show predictions as predictions

A compact ordered Change list exposes planned atomic messages, existing native JJ IDs, intent, predicted reads/writes and fast/slow/delivery checks. Planned null IDs remain unassigned. Selection is persisted through `runs.coding.select`; selecting the current Change again collapses it. Slash commands, buttons and agent calls use the same flow and schema-derived form path.

Manual runs retain their input Plan. Prompt requests derive the latest Plan from a successfully completed owned PreparePlan or PrepareWithWiki child, or from a completed owned Request result. Native ancestry, generation and the selected historical cursor fence that projection. An earlier historical selection cannot show a later prepared plan; ambiguous or malformed evidence creates no substitute plan.

## Separate product outcomes from execution status

The recorded CorrectPlan output or enclosing Request outcome supplies validated, changes-requested or blocked. Engine completion alone cannot supply those states. A blocked child links through recorded native trace evidence while retaining the source card's workspace binding. The UI shows raw receipts and results in recursive detail; it does not manufacture a passing check from a successful procedure that returned a failure value.

Gateway and workspace identity qualify persisted run references. Separate workspace databases may both contain the same run ID, so navigation and commands must retain the originating card's binding. Native child execution IDs are inspected inside their owning trace, not sent as unrelated Control run IDs.

## Retain the prototype for inspection

A completed owned Poc child supplies the saved prototype only when its result names the exact input source. The card displays the drafted-unvalidated finding and expandable full before/after source as escaped text. It does not execute retained HTML. The existing steer form can submit feedback; queue acknowledgement alone does not establish replanning or revision acceptance.

Keyboard-accessible source panels, actor-tagged selection, historical cursor and reload use existing card state. The current shell keeps chat history in the main view and summons only the bottom composer with Command-K or Control-K. The [design study](coding-experience.md) records further recommendations, separately from these implemented projections.

## Keep proof provenance visible

The projection tests define regressions for schema, source identity, ancestry, cursor and generation boundaries. Their fixtures are evidence of the cases the tests exercise; a test file is not a receipt that the tests ran. The owning workbench guide records broader browser checks and their retained-versus-synthetic fixture limits. A browser fixture is not a deployed coding canary.
