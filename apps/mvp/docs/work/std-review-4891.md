---
title: Standard tool review corrections
status: done
area: std
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4891
---

Fix fingerprint suffix pruning, escaped search patterns, private checkpoint
staging, and unreachable patch and redirect branches. Empty-tree measurement
and timeout output retention already have fixes and regression tests in
`4c15c04c65ee`.

Library catalog: `@smthrs/std` supplies these standard agent tools; use its
existing injected process and HTTP services.

Regression evidence: six assertions failed against the unchanged base across
fingerprint suffix directories, escaped search punctuation, and shadow-directory
permissions. With the fixes, all 91 standard-tool suites pass: 1,784 tests pass
and 32 platform-specific tests skip, with 100% statement, branch, function and
line coverage. Package typecheck and lint pass with the pinned `rg 14.1.1`.

The module mock is replaced by a real large-hunk input. The applier retains its
existing engine-dependent argument-count limit and safe generic failure handling;
changing that separate behavior is outside this correction's scope. The test
asserts that its diagnostic is logged and its engine exception stays out of the
tool result. The parser's unreachable generic path is removed.

Astra and Fable reviewed the change. Fable's two stale redirect-header descriptions
are corrected. Generated API and LLM pages, the package documentation map and all
52 published package tarball checks pass. The `docs-sync` wrapper cannot load on
the validation image because its native filesystem helper is absent; the exact
underlying generator and validation modules pass. The target index is current.
