---
title: In-memory engine admission and action cancellation
status: done
area: flows
owner: codex-fix-942789
updated: 2026-10-21
links: []
---

Use the library catalog's durable workflow entry (`@smthrs/flow`) and its existing `@smthrs/engine` runtime.

Regression tests cover interrupted admission leaving a parent edge and an interrupted action owner cancelling duplicate callers. Registration closure already has a publication guard and a regression test on the starting revision.

Validation on Latitude: both new concurrency regressions failed before the fix.
After the fix, all 617 engine tests pass with 100% statement, branch, function,
and line coverage. Engine `pnpm run check` and the app's `pnpm exec tsc --noEmit`
pass. The package has no `importRules` target; its underlying checker passed four rules against
the changed files for platform neutrality, Effect boundaries, root imports in
regressions, and condition-based test waits.

The registration-closure finding is not reproduced: the starting revision's
`publish` checks registration before installing state and passes the existing
last-registration closure regression.
