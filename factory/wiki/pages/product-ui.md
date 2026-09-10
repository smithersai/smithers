# Embedded UI and recursive inspection

The UI interaction contract calls for shared registered flows, persisted state, cards and frames across presentation modes. The current onboarding brief supersedes the older always-visible-composer rule: the UI and chat history occupy the main view, while Command-K / Control-K summons only a solid bottom-docked composer that pushes content upward. Under the interaction contract, maximizing a card is a presentation change of the same component and state.

## One flow, three doors

A button, slash command and agent invocation share the same registered action. Required missing arguments render a schema-derived form. Human-only gestures have enumerated exceptions rather than silently hiding consequential capabilities from the agent.

State that a card projects belongs in TanStack DB and changes through the shared actor-tagged transition dispatcher. The UI rules prohibit React effects for application state synchronization. These are contributor requirements; use the owning tests and source to judge compliance of a particular component.

Every required action must have a keyboard path with visible focus and predictable focus movement. The shell controls when the composer is visible; an older embedded-card test is not evidence that the composer must remain visible throughout onboarding.

## Inspect real execution structure

The existing `RunTrace` projection and card provide a starting point for execution inspection. Keep a selected run, frame or cell connected to its recorded evidence. Historical values must come from the historical execution record; today's live state is not a substitute when an old node is selected.

The trace card now starts with a cheap Turns view: bounded excerpts of recorded model prose, falling back to actual call names for code-only responses. Selecting a turn opens its recursive call tree and details in the same card. The selection pins the journal prefix; Latest returns to live turns. These are recorded model words, not independently verified semantic summaries. Realm variable snapshots and some child-run links remain unavailable, and same-name concurrent call settlements retain the journal's FIFO association limit.

## Keep wiki truth visible

The UI rules describe the wiki as Markdown-native linked documents in its own TanStack DB collection, with provenance, confidence, actor and revision. Inferred world state must not look like ground truth. Generated wiki pages therefore expose freshness and semantic verification separately. The generator leaves canonical human-authored pages outside its output directory and does not overwrite them; explicitly catalogued intent can appear as a generated snapshot copy.

## Decode native coding evidence separately

Native executions appear beside recorded agent turns. Their results use the existing engine codecs and recorded parent edges; they are not invented model turns. The [coding view](coding-ui.md) derives prepared plans, retained POCs and product outcomes from completed owned children. The [observation contract](native-engine-evidence.md) explains why terminal Control status can coexist with a pending final native drain.
