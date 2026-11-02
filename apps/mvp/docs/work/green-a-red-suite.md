---
title: Clear main suite failures in lane green-a
status: done
area: testing
owner: Codex GPT-6.1 Sol
updated: 2026-11-01
links:
  - ../design/timeline/DESIGN.md
---

Repair schema prefix normalization and execute the five stranded suites; check timeline containment against FE-16/FE-19; prepare real sandbox test images with the deployment CLI pack; reconcile GATE_IMAGE bindings; enforce the existing desktop screenshot deadline through cleanup.

Uses the catalog's @smthrs/database fixture identities and @smthrs/ui timeline. Checks run only on the Mac mini. Each fix lands separately; final whole-suite counts are recorded in green-a-STATUS.md outside the repository.

Schema fix: shared identities normalize hyphens before truncation. All 55 stranded tests and 10 schema/reaper tests pass; library regressions 2/2 and all four typecheck projects pass on the mini.

Desktop cleanup: viewport redraw consumes the full-page capture’s remaining budget; expired captures finalize their evidence interval without a second font wait. The real blocked-font regression retains the 15-second bound and verifies no later output or interval mutation.

Gate bindings: `JobMachines.declared` reads `GATE_IMAGE` during ChatApi planning and the hosted sandbox layer reads it too. Infrastructure docs correctly name its consumers. The plan fixture now supplies a digest-pinned image so both documented inventory and real offline binding checks cover the gate-enabled deployment.

Sandbox test images: a shared Vitest global setup selects the four real-container suites, packs the deployment CLI from this checkout once before workers start, and builds the image on each selected available engine. Runs without those suites do no packing. Suites use that image rather than racing independent builds.

Timeline: browser assertions follow DESIGN.md’s readable words and wrapping contract, wait for real column animations, use the current shared tooltip, and render the shell’s actual centered column with TIMELINE_ROOM. The phone’s old parent bound compared a displaced label against its short mark, not the rail. Hover previews now stay within the rail instead of extending into the transcript; the browser regression retains the original transcript boundary and adds the rail boundary.

Validation on the mini: restored suites 55/55 and schema/reaper 10/10; database library 2/2; desktop and recording 17/17 (deadline cleanup 11.06 seconds under the unchanged 15-second assertion); gate bindings 3/3; real-container suites 13/13; timeline browser cases 6/6; UI timeline unit tests 20/20. Full-suite verification follows landing and is recorded in the lane STATUS file.
