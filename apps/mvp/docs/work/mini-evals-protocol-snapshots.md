---
title: Validate eval scorer batches and suite snapshots
status: done
area: sdk
owner: Codex mini/fix-packages-smithers-agent-evals-src-453475
updated: 2026-10-22
links: [../../../../packages/smithers/agent/evals/docs/troubleshooting.md]
---

Reproduce null scorer observations, control characters in protocol and timestamp
diagnostics, and throwing suite snapshot getters before fixing them. Use the
library catalog entry “Run an eval suite against a committed baseline”
(`@smthrs/evals`, `@smthrs/scorers`) and its existing Effect error channels.

Validate only the affected package and the app typecheck. E2e: not run (mini clone).

All four findings reproduced before changing production code: 18 regressions
failed with null-observation defects, unsafe protocol/timestamp diagnostics, and
throwing snapshot getters. The fixes retain typed errors and flatten diagnostic
controls through the existing sanitizer. A sparse-batch regression also covers
absent observations.

Validation: `pnpm --filter @smthrs/evals exec vitest run` passes all 268 tests
with 100% statements, branches, functions, and lines. Package test typecheck,
`pnpm exec tsc --noEmit` in `apps/mvp`, changed-source ESLint and dprint pass.
`pnpm exec smithers-build test '//packages/smithers/agent/evals:importRules'`
passes. Added the package's fixed-sleep import rule and regenerated its target
index with `pnpm run target-index`. No device schema changes.
