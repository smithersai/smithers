---
title: Repair main workflow infrastructure
status: in-progress
area: ci
owner: codex-ci-infra
updated: 2026-10-29
links:
  - ../rules.md
---

Repair trusted drift and setup image selection, classify native Windows and package failures,
and retire the unused Plue mirror under SCOPE-3. Keep the trusted setup checks and activation
gate intact; do not extend known-red entries. Use the library catalog's @smthrs/repo-targets
contracts and @smthrs/targets workflow generator. Delivery is builder/ci-infra for the lander.
