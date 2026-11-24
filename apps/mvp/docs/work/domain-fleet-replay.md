---
title: Replay domain removals and fleet snapshots safely
status: blocked
area: worker
owner: Lane R3-2
updated: 2026-11-23
links: [../features/domains.md, ../features/fleet.md]
---

R3-Astra-D4-003. A removal without a generation can resume only from its own withdrawal receipt. The Postgres regression runs the legacy payload after the same repository reclaims the hostname. It also covers a provider retry with a receipt. The domain continues to use the library catalog's `@smthrs/flow` entry.

R3-Astra-D4-004. The final fleet chunk writes a receipt in the existing Effect SQL transaction. Replays return the recorded counts and preserve newer session observations. Reports prune receipts older than seven days.

Both replay regressions failed before the fixes. With the fixes, all 103 domain and fleet tests passed on Postgres. ESLint reported zero warnings and importRules passed. The app, worker and infra typechecks passed. The evals typecheck reported five TS2339 errors in `packages/smithers/src/Legacy.ts` at lines 78, 79 and 82. The same caller and Effect-returning `RunState.readDatabase` signature are present at parent revision `c253439a`. Repair of that package is outside this lane.
