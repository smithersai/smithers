---
title: Control channel behavioral coverage
status: done
area: control
owner: codex
updated: 2026-11-13
links:
  - https://github.com/smithersai/smithers/issues/4868
  - packages/smithers/control/test/Channels.test.ts
  - packages/smithers/control/test/ChannelBoundary.test.ts
---

Replace the channel coordinator's fixed `Control` receipts with `TestControl.layer()`.
Exercise approval, replay, pending plans, and a reused run key through real `Control`
operations. Assert stored runs and plans as well as returned receipts.

Assert `InvalidInput` for invalid webhook schema data, preserve the observable
delivery identity assertions without a prototype spy, and remove the assertion
that tested only Effect's credential wrapper.

The security review's deploy-class list follows the catalog: `release`, `serve`,
`up`, and `target`. The retention procedure `gc` keeps its existing behavior.

Validation: all 39 targeted tests pass. The full SQLite/PostgreSQL package
matrix passes with 100% combined statement, branch, function, and line
coverage. Package typecheck, lint, import rules, and target-index drift checks
pass.

Mutation checks show that the old tests pass with a decoding defect, the wrong
typed failure, or a fabricated run receipt; the strengthened tests fail for
each. Caching conflicting ingress receipts also fails the real-key conflict
regression. Temporary mutations were restored.
