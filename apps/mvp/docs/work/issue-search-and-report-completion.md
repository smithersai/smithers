---
title: Preserve bug-report completion and issue identity
status: done
area: issues
owner: codex
updated: 2026-11-12
links:
  - https://github.com/smithersai/smithers/issues/5262
---

Bug-report completion applies only to its submission, and a stored report stays sent.
Issue creation requires a complete shape search; invalid pages and exhausted pagination
remain retryable failures. Review aliases merge every connected group while retaining
its evidence, labels and review links.

Regression coverage exercises delayed completion, malformed and incomplete pages,
cursor recovery, the final pagination boundary and transitive alias bridges.

Validation: all 1,571 related tests pass. With the unchanged production sources,
12 regressions fail. The full app suite completed with 7,830 passing tests;
its unrelated failures include an unavailable review import, missing browser
binaries and a run-graph assertion, also reproduced on the unchanged base.
The app's typecheck and lint diagnostics match the unchanged base.
Documentation sync and checks could not finish without the required filesystem isolation helper.
