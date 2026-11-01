---
title: Release bottom follow when scrolling from the timeline rail
status: done
area: timeline
owner: codex-tl-wheel2
updated: 2026-10-31
links:
  - timeline-wheel.md
---

Will's production failure is confirmed through real ChatTranscript/MessageScroller + ChatTimeline: rail input moves 1800 → 1000, then the next React commit returns to 1800 before a scroll event. The synthetic event is delivered; `cancelProgrammaticScroll` measures the still-bottom viewport and retains follow when there is no read anchor. There is no trusted-event check. Arrival reads also need to be marked moved before maintenance, rather than waiting for a scroll event.

Library catalog entry: `@smthrs/ui`. The public scroller command `scrollByReader(delta)` shares native wheel release, cancels pending navigation and read pins, moves in CSS pixels and reconciles edge state. ChatTranscript supplies the same provider to its rail and viewport. Standalone rails retain their direct viewport path. The driver preserves unit normalization, rail-only prevention, pinch/horizontal exclusions and navigation, with no synthetic event.

Mac mini validation:

- Regression first failed: expected scrollTop 1000 after commit/frames, received 1800.
- After the fix and spacing-lane rebase: all 2,763 UI tests pass; UI `tsc -p . --noEmit` and app `vibelang -p tsconfig.json --noEmit` pass.
- All 32 changed executable source lines covered; focused scroller/driver suite: 94 tests pass. Coverage includes bottom follow, arrival reads, native-wheel parity, no synthetic event, absent viewport, zero input, pinch preservation and returning to follow.
- WebKit conversation journey passes (50.9 s). Chromium isolated rerun passes (29.2 s), with browser/network guards unchanged. Both exercise bottom-pinned wheel up/down, persistence through a real preview commit and later frames, pinch, desktop and three responsive sheets.
- The browser fixture chooses the real Latest command and verifies stable bottom frames before wheeling; it hovers actual marks and permits the Latest button to disappear during its actionability wait. The old frozen-height assertion contradicted the spacing lane's proportional FE-22 geometry and was removed; label overlap and mark hit tests remain.
- The complete timeline spec was executed. Its untouched branch journeys still expect TODO/run rows excluded by FE-16 and fail that assertion. A combined browser rerun also caught Electric shape 503s in Chromium teardown; the isolated Chromium rerun is clean. No guards were weakened.

Runtime fix landed as `a6894b7451a5`. No deploy. Logs and changed-line coverage summary are retained beside `~/smithers-builders/tl-wheel2-STATUS.md`.
