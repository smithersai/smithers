---
title: Align Supervisor retry payloads and pattern contract tests
status: done
area: sdk
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/4702]
---

The declared `Supervisor` passes the same string-only retry ids as `run`.
Regression cases compare both surfaces with mixed entries, duplicates, unknown
ids, and malformed reviews.

The `Burndown` contract tests assert schema defects and the invalid field.
The child execution test polls the derived ids and verifies the completed results.
Internal member and decorator comments describe the helpers that exist.

Validation: all 818 tests across 41 files pass with 100% statement, branch,
function, and line coverage. Package typecheck and lint pass. The package-docs
generator, drift check, and all 52 published-package tarball checks pass.
The site API and LLM projections are current. Astra and Fable reviewed the
change; the defect-message and graph-input assertions include their feedback.

No public API change is required.
