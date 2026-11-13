---
title: Artifact cleanup documentation and host failures
status: done
area: sdk
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/4525
---

Correct the artifact store's cleanup, scratch-token and import documentation.
Keep both filesystem causes readable when an operation and its existence probe
fail, while retaining the structured causes. Uses the library catalog's
`@smthrs/artifacts` entry and its injected Effect filesystem service.

Validation:

- Both strengthened double-failure regressions fail against the original source.
- Package suite: 435 passed, one permission test skipped when running as root;
  100% statements, branches, functions and lines.
- Package `check`, `lint` and `circular`: passed.
- `pnpm docs:sync` and `pnpm docs:check`: passed, including all 52 published
  package tarballs. API-page and LLM-bundle drift checks passed.
- Codex Astra and Claude Fable reviews: no material findings.
