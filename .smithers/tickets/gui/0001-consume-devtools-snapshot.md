# GUI: Consume DevToolsSnapshot / Delta Stream

> Target repo: **gui** (`/Users/williamcory/gui` — Smithers GUI, Swift/SwiftUI macOS app)
> Source: memo §4 · `live-run-devtools-ui.md` §1–§9

## Problem

The current GUI flattens Smithers runs into "task cards" and a chat
transcript per task. That model throws away tree structure, props,
iteration, and parallelism — the things operators need in order to trust
a live run. The live-run devtools spec already calls this out: "Smithers
IS React — we render it as React."

## Goal

Replace `LiveRunChatView` with a React DevTools-style tree + inspector
backed by the same `DevToolsSnapshot` / delta stream the TUI and JJHub
web UI use.

## Scope

### Data layer

- New `DevToolsClient.swift` — connects to Gateway
  `streamDevTools(runId, afterSeq?)` over WebSocket.
- Decodes `DevToolsSnapshot` and `DevToolsDelta` JSON shapes
  (generated from the server schema; do not redefine types).
- Applies deltas to a `DevToolsStore` (observable). One store per open
  run.
- Exposes `RunStateView` (smithers/0015) fields to the header view.

### UI

Matches `live-run-devtools-ui.md`:

- **Header**: runId, workflow name, elapsed, dual heartbeats
  (smithers/0016), state + reason, rewind button.
- **Tree pane** (left): virtualized, collapsible, searchable; node
  icons by `SmithersNodeType`; state glyph per node; error badge
  bubbles to collapsed ancestors.
- **Inspector pane** (right): props, state, iteration, tool-call list
  with side-effect badges (smithers/0019), tabs: Output / Diff / Logs.
- **Frame scrubber**: view-only time travel by default; `Rewind`
  requires confirm + scope.

### Mutations

Go through Gateway (smithers/0023) — approve, deny, signal, cancel,
resume, rewind. Audit row id returned surfaces a toast linking to the
history pane.

### Deprecations

Remove `LiveRunChatView` for the new view once shipped. Keep the chat
log as one of the inspector tabs (not the main surface).

## Files

- `SmithersGUI/Runtime/DevToolsClient.swift` (new)
- `SmithersGUI/Runtime/DevToolsStore.swift` (new)
- `SmithersGUI/Views/RunInspector/` (new)
  - `RunInspectorView.swift`
  - `RunTreeView.swift`
  - `NodeInspectorView.swift`
  - `FrameScrubberView.swift`
- Delete / refactor `LiveRunChatView.swift`

## Testing

- Unit: delta application yields a snapshot byte-identical to a fresh
  server snapshot fixture.
- UI test: tree virtualization handles 10k nodes without frame drops
  (measure with Instruments; record budget in the test).
- UI test: selecting a node updates the inspector within one frame.
- Integration: against a local Gateway fixture, live run updates the
  tree in real time.
- Accessibility: VoiceOver traversal of the tree is sensible.

## Acceptance

- [ ] No bespoke type definitions; types are generated from the
      Smithers server schema.
- [ ] Tree + inspector + scrubber render a fixture run that matches a
      visual snapshot.
- [ ] All Gateway mutations work with proper scopes (smithers/0023).
- [ ] `LiveRunChatView` removed; chat log lives in an inspector tab.

## Blocks

- Depends on smithers/0010–0013 (DevTools RPCs), smithers/0015, 0016,
  0023.
- Shares design with jjhub/0003; keep parity with the spec.
