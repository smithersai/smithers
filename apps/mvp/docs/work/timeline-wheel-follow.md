---
title: Release bottom follow when scrolling from the timeline rail
status: in-progress
area: timeline
owner: codex-tl-wheel2
updated: 2026-10-31
links:
  - timeline-wheel.md
---

Fix forward for Will's production reproduction: rail wheel must release bottom follow synchronously and hold the reader's position across commits. Library catalog entry: `@smthrs/ui`. Regression and all heavy validation run on the Mac mini. No deploy.

Confirmed on the mini through real ChatTranscript/MessageScroller + ChatTimeline: rail input moves 1800 → 1000, then the next React commit returns to 1800 before a scroll event. The synthetic event is delivered; `cancelProgrammaticScroll` measures the still-bottom viewport and retains follow when there is no read anchor. There is no trusted-event check. Arrival reads likewise must be marked moved before maintenance, not deferred to their scroll event.

The public scroller command `scrollByReader(delta)` shares native wheel release, cancels pending navigation and read pins, moves in CSS pixels and reconciles edge state. ChatTranscript supplies the same provider to its rail and viewport. Standalone rails keep their direct viewport fallback. The driver retains unit normalization, rail-only prevention, pinch/horizontal exclusions and navigation.

Mini receipts: regression first failed (expected scrollTop 1000 after commit, received 1800). After the fix all 2,745 UI tests pass, including bottom-follow, arrival-read, native-wheel parity, no synthetic events, absent viewport, zero delta and returning to follow. UI `tsc -p . --noEmit` and app `vibelang -p tsconfig.json --noEmit` pass. Browser timeline validation and changed-line coverage receipts are pending.
