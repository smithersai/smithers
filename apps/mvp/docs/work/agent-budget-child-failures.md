---
title: Budget accounting and child failure sanitization
status: done
area: agent
owner: codex-fix-packages-smithers-agent-src-475638
updated: 2026-10-21
links:
  - packages/smithers/agent/src/Budget.ts
  - packages/smithers/agent/src/EngineChildren.ts
---

Reproduce seven reported accounting and sanitization defects, then retain failing-before and passing-after evidence from Latitude.

Catalog entries: `@smthrs/agent` for budget enforcement; `@smthrs/journal` Redaction for child diagnostics. No new library.

Confirmed all seven findings. Regression-first Latitude run: ten budget assertions
failed for the reported behavior; the additional resume case initially had an
invalid Effect invocation, corrected before passing validation. Both child
sanitization assertions failed on the original code.

Implementation: journal-only account eviction, warning fall-through, fail-closed
suspension transitions inside transactions, shared recovery for uncached usage,
positive minimum raises, redaction before clipping child failures, and store
warnings containing only the error code and the known get operation.

Validation: 270 affected tests passed across 11 files, including cross-process
recovery. A final formatted-source run passed 54 tests across BudgetFindings and
EngineChildren. TypeScript check and ESLint passed. The requested importRules
command reports unknown_label because this package declares no such target.
Full package run: 159 files passed, two skipped, one failed; 2,124 tests
passed, six skipped, one failed. The sole failure is Fault.sweep's missing
classification for the unchanged `flows/flow/src/Action/once.ts` error
`@smthrs/flow/EffectKeyUnavailable`. A Latitude rerun with both original source files reproduced exactly the same failure (nine passed, one failed).
Coverage was enabled; this failing suite prevents a successful coverage receipt.
