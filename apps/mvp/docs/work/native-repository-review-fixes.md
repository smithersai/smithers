---
title: Native repository and filesystem correctness
status: done
area: repo
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5392
---

Fix the native merge comparison baseline, metadata operations on unreadable owned
files, and glob response accounting. Use the existing `jj-lib`, `libc`, and
`serde_json` dependencies; no new library or public API is needed.

Regression coverage exercises the C ABI and the packaged filesystem helper with
real repository trees, real permissions, and exact encoded response limits.

The unchanged base reproduced all three defects: an empty merge reported a
parent-only file, a narrow glob returned EFBIG because of unrelated siblings,
and an unreadable owned file refused a metadata change with EACCES. The
regressions pass with the fixes, including reversed merge parents, conflicted
merges, subsequent edits, exact JSON response bounds, and retained link checks.

Validation: Rust formatting, Clippy on all targets with warnings denied, the
complete native test suite, and the trusted-process source-import test passed
on Linux. After rebasing over the independent line-counting fix, the checks
passed again; the unchanged large-document stress case was not repeated.
API documentation, LLM documentation, and package documentation-map projections
also pass their checks. Native Windows and macOS execution remains with their
platform jobs. Independent review found no remaining findings.
