---
title: Harness timeout and completion documentation
status: done
area: harness
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4827
---

Correct the recorded-timeout replay guarantee, the armed claim cap's
fail-closed behavior, and the root-only namespace inventory. Keep runtime
behavior and package exports unchanged. Extend the existing public documentation
checks and validate the package and generated documentation.

Validation: all seven new documentation checks fail against the original text.
The harness suite passes 2,694 tests with 100% coverage; source and test
typechecks and package lint pass. Both generated site projections, the redirect
map, and all 52 published package documentation tarballs pass. Runtime source
is identical after removing comments; package exports are unchanged.
Codex Astra and Fable reviews pass.

The unmodified base has the same stale realm bundle and unrelated flows
quickstart release pin failure. The documentation flow wrapper cannot load
without its native filesystem helper; its underlying documentation checks pass.
