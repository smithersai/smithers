# GUI: Reconnect-from-Cursor + Ghost State

> Target repo: **gui**
> Source: memo §1, §4 · `live-run-devtools-ui.md` §7, §9

## Problem

A GUI that loses its place when the network blips — or forgets about a
node the moment it unmounts — is exactly the kind of UI the field report
warns against: "dashboards that don't reflect reality are worse than
nothing." The GUI must cold-resume transparently and preserve
last-known state for nodes the engine has torn down.

## Goal

Sequence-cursor reconnect and ghost-state retention, matching the
semantics every other Smithers inspector will follow.

## Scope

### Reconnect

- The `DevToolsClient` (from gui/0001) persists `lastSeqSeen` per run.
- On reconnect it sends `streamDevTools(runId, afterSeq: lastSeqSeen)`.
- On `GapResync { fromSeq, toSeq }` (smithers/0023 semantics), the
  store discards its tree and accepts the follow-up snapshot instead of
  trying to patch deltas it doesn't have.
- UI behavior: a subtle reconnect indicator in the header; never
  blocks interaction with the current state.
- While disconnected, show the stored state with a "stale since …"
  banner — never blank the screen.

### Ghost state

- When the engine unmounts a node, the delta stream removes it from
  the active tree. The store keeps the node in a `ghost` map keyed by
  `nodeId`.
- Ghost nodes render in a dimmed style; clicking through inspection
  history still resolves them.
- If the user had a ghost node selected, the inspector continues to
  show last-known props/state/output, plus a badge: "unmounted at
  frame N".
- Ghost state clears only on explicit reset (new run opened, user
  clicks "clear history") or on rewind past that node's mount.

### Background tabs

- Runs in other tabs keep their subscription alive; dropping them
  would defeat the cursor logic. Memory budget: `N × (tree size +
  recent events window)`. Document the budget; evict oldest ghost
  nodes past a configurable cap.

## Files

- `SmithersGUI/Runtime/DevToolsClient.swift` — reconnect logic
- `SmithersGUI/Runtime/DevToolsStore.swift` — ghost map, eviction
- `SmithersGUI/Views/RunInspector/RunTreeView.swift` — ghost styling
- `SmithersGUI/Views/RunInspector/NodeInspectorView.swift` — ghost
  badge

## Testing

- Unit: drop the WebSocket mid-stream; reconnect replays missing
  deltas; final state matches a fixture.
- Unit: `GapResync` → store discards and accepts snapshot; no partial
  state.
- Unit: unmount a node while selected; inspector keeps last values;
  badge shown.
- Integration: rewind past a ghost node's mount → ghost entry cleared.
- Soak: 30-minute connection with induced 5s drops every 60s — memory
  within budget; no frame drops > 16ms in the active tree.

## Acceptance

- [ ] Reconnect is invisible on short blips (< 2s).
- [ ] Long disconnects show a "stale since …" banner and never clear
      the tree.
- [ ] `GapResync` handled correctly; no silent state corruption.
- [ ] Ghost state preserves last-known values with a clear visual
      marker.
- [ ] Memory budget documented + enforced; eviction policy tested.

## Blocks

- Depends on gui/0001, smithers/0023.
