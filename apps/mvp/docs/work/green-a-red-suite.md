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
