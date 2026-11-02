---
title: Clear main suite failures in lane green-a
status: in-progress
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
