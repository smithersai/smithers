---
title: Strengthen target review and secret regression tests
status: done
area: targets
owner: Codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/5060]
---

Strengthen the declared-output freeze, coverage arguments, and completed-review
assertions. Remove a misleading tool-execution assertion, correct the workspace
attribute description, clean up temporary review trees, and document that
`SafeFs` treats `ENOTDIR` as an absent path.

Require complete coverage of `@smthrs/targets`, using real filesystem and
process behavior, injected faulty services, and private platform-policy seams.
Retain security guards and the existing public behavior.

Validation: all 184 test files pass, with 3,639 passing tests and five platform
skips. Statements, branches, functions, and lines each reach 100% coverage.
The package typecheck and lint pass, with no unhandled errors. Final reviews
found no remaining issues.
