---
title: "Cacheable Node tests and unjudged lint findings"
status: done
area: build
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5061
---

A cached `NodeTest` suite must declare a source input or dependency because
runner directory strings do not enter the content key. Oversized files that
`JevLint` cannot judge retain the strongest severity of their covering rules,
so an unjudged error rule fails at the default threshold.

Validation covers cached runner inputs, an empty suite's refusal, and oversized
files under error, warning and info rules and thresholds.

Validation: all 44 targeted tests pass; the new regressions fail against the
unchanged implementation. Package typecheck and lint pass. The full suite has
3,112 passes, seven skips and six confinement or permission failures, all six
also reproduced on the unchanged implementation. The docs redirect-map check
and all 52 published-package documentation checks pass through their source
modules; the docs flow CLI needs the native filesystem helper.
