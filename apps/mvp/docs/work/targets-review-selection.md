---
title: Review target file selection and security model calls
status: done
area: targets
owner: codex
updated: 2026-11-11
links: [https://github.com/smithersai/smithers/issues/5049]
---

Review includes must retain every path minimatch accepts, including extglobs.
Security reviews expose the alternate family's model through the declaration and
action payload, retaining the existing defaults. Failed model calls return one
attempt receipt; retry policy belongs to the durable flow (DUR-2, SDK-9).

Uses the existing `@smthrs/targets` review action and `@smthrs/model` transport
from the library catalog. No new runtime or provider integration is introduced.

Regression coverage: `ReviewTransport.test.ts` exercises both file-selection
scopes, both primary engines, configured verification, and failed-call counts.
`SecurityReview.test.ts` checks declaration-to-action forwarding and validation.
`SecurityCompletion.test.ts` checks failure receipts and completion rules.

Validation: 3,033 package tests passed and three were skipped. The sole full-suite
failure is the unchanged dependency-patch assertion tracked in
[#5365](https://github.com/smithersai/smithers/issues/5365). Configured coverage
thresholds, package typecheck, lint, and the docs-map check passed.
