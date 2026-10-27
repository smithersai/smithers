# Conversation timeline

`ChatTranscript` accepts a `rail` contribution. Pass `ChatTimeline` entries with transcript anchor ids, kind, recorded state and an optional short summary, actor, time, duration, token total and formatted cost. The host supplies data; the component never calls a model. It appears at a viewport width of 1180 pixels when the transcript column is at least 600 pixels wide, outside the message column, and stays closed on narrow screens until the conversation’s Timeline header control is activated. The control works with touch, Enter and Space; the sheet overlays chat without reducing its width. Rows keep their height when summaries arrive.

```tsx
<ChatTranscript rail={<ChatTimeline entries={entries} onJump={jump} />}>
  {messages}
</ChatTranscript>
```

Native buttons activate with Enter or Space. Arrow keys and J/K move to the neighboring entry and jump; Home/End reach the boundaries. Without `onJump`, it scrolls the matching DOM anchor into the transcript viewport. `onJump` handles scrolling during keyboard traversal. `onActivate` handles explicit activation (click, Enter or Space) of one entry, for destinations such as a TODO page; groups and focus movement never activate a destination. Without `onActivate`, activation also jumps. The inclusive visible band follows transcript scroll and resize. The resting rail uses small, muted type and a thin viewport marker. Hover or keyboard focus reveals a compact summary, actor, supplied time/duration, tokens/cost, status and jump hint. Optional evidence is omitted when absent; the component never estimates billing or timing. Waiting and failure rows use theme warning/danger colors; their transcript cards must retain written states.

`timelineKey` and `timelineLabel` are pure helpers. Supply `label` with the recorded object and outcome while a summary is unavailable. A nonempty `summary` takes precedence over `label`; legacy callers without either retain state labels. Its host must invalidate summaries when entry content changes and must never supply secrets as labels or summaries.

Zoom levels share a horizontal flex row on desktop, with blocks distributed vertically within each level. `onGroupsChange` reports changed visible groups; an inline callback may update parent summaries without requesting the same groups again. Enabling the callback requests the current groups.

Each zoom column shows its label. Compact row labels use an ellipsis instead of splitting words or painting outside their boxes; focus or hover reveals the full summary. Desktop previews remain within the rail beside the transcript.
