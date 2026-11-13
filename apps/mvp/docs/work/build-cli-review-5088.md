---
title: Build CLI environment and selection corrections
status: done
area: build
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/5088
---

Correct child environment injection and credential withholding, Anvil tool
identity, workspace-relative affected paths, lockfile classification, audience
precedence, and outdated build CLI references. Preserve the existing CLI
extension callback type and its default audience.

Added 48 regression cases using real child processes and declaration graphs.
Package typecheck and lint pass. Ten affected and related test files pass
430 tests, with six optional-tool skips. The documentation generator tests
pass all 13 cases, and documentation checks pass for all 52 published package
tarballs. API and site projections were regenerated and checked.

Comparison runs of the full package suite reported the same 130 failing
test names and six unhandled errors on the base and patched trees. Existing
coverage floors were preserved. The documentation flow entry points require
the unavailable native export helper; the underlying projection generator
and published-package checks pass directly.
