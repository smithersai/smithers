---
title: VibeLang fuzz package and whole-app fuzz campaign
status: in-progress
area: vibelang
owner: Codex vl-fuzzpkg
updated: 2026-11-07
links:
  - apps/vibelang/wiki/decisions/0015-fuzzing.md
---

Copy the Effect fork fuzzer to @smthrs/fuzz, land it, then build independently measured whole-app fuzz coverage and retain a 30-minute campaign on nyc-01. Library catalog: @smthrs/testing owns Node test tooling, @smthrs/repo-targets supplies the package targets, and @smthrs/flow owns durable actions.
