---
title: Timeline rail geometry and visual parity
status: done
area: timeline
owner: Codex geometry lane
updated: 2026-10-31
links:
  - ../design/timeline/timeline.html
  - ../decisions/0140-timeline-covered-windows.md
---

Implements Astra findings 7–10 and 13b using the library catalog's `@smthrs/ui` entry. Markers carry inclusive covered endpoints; gaps and tails remain pending. History requests only mount, then restore a message ID and fractional position. Every level has bounded windows, including further semantic levels through `higherLevels`.

Two real browser races were reproduced and corrected: a live-edge history read was repinned by the scroller before its native scroll event (13,092px drift), and resize measured a new box before React committed a new block pitch (320px stale transform). The scroller releases follow for the explicit read. Main’s later FE-22 position-scale layout supersedes fixed-pitch transforms; its completed renders recompute geometry without forcing window reselection, retained with an adapted resize/render regression. Numeric layout/window diagnostics expose both stages without content.

Final mini verification: 156 UI/scroller tests, 53 fixture-prerequisite tests and 12 host projection tests pass. The five measured rail/scrolling source files each have 100% executed line coverage. The UI package's canonical VibeLang check passes. Native 50-arc probes render four bounded levels through a same-page 804px→544px resize, including lens bounds; the unit suite covers the original 704px case. Astra and Fable reviews found no blockers.

The Chromium Darwin journey asserts 17 references, refreshed for FE-22 after rebasing: three conversation lengths, light/dark at 1440×900 and 1280×800, resize, drag, phone sheets and reduced motion. It checks real unmounted-history navigation within 1.5px. Each fixed API batch is seeded before opening its device, then real Electric entry/phase/arc receipts and rendered coverage must match before capture. After the fixed-target drag it resizes down and back, verifies the same message ID/fraction within 1.5px at both sizes, then grades the window selected by that real resize. Image difference tolerance remains 0.001.

References require the declared `timelineVisualFixture`: an exclusive fresh local database. A shared-suite run without it reports the fixture unavailable, separately from passing coverage. The dedicated run checks a complete empty server snapshot and exact fixture IDs/counts. The rebuild's Chromium-only visual policy is retained; WebKit rail navigation remains in the existing navigation journey.

Reproduce with `MINI_RUN_SRC=$PWD ~/.smithers-lead/scratchpad-mirror/mini-run -e E2E_TIMELINE_VISUAL_FIXTURE=fresh apps/mvp -- caffeinate -di -t 1800 pnpm exec playwright test e2e/timeline-look.spec.ts --project local-turns --grep 'phases read'`. The runner owns its slot and resets its database. Generate with `--update-snapshots`; verify without it.

FE-22 overrides the approved mock’s even spacing; its quiet palette, track, lens and funnel remain. Thirty mock/app comparison and stress PNGs are in `~/Desktop/smithers-mvp/timeline-parity/`, listed in the lane STATUS file. No deployment in this lane.
