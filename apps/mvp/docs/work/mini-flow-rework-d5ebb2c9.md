---
title: Rework bounced durable retry and payload reference fix
status: done
area: sdk
owner: Codex mini/fix-rework-d5ebb2c9-190528
updated: 2026-10-22
links: [../../../../packages/smithers/flows/flow/docs/api.md]
---

Rework d5ebb2c9ecfb on main@origin. Keep durable transient retries and one
payload Ref input per placeholder occurrence in canonical traversal order.
Main already guards fatal drafts and renders non-plain placements inertly.

Library catalog entries: durable workflows and retries in @smthrs/flow;
the real FlowEngine runtime in @smthrs/engine. No new runtime or retry loop.

The obsolete unary retry loop now dispatches a schema-encoded keyed action.
The engine owns attempts, waits, replay and their existing metrics and spans.
ExecutionIdentityConflict registration moves to Fault to keep imports acyclic.
Hidden issue-sweep callers migrate with typed outage codecs and invocation-scoped
actions; distinct fetch/push calls cannot reuse each other's result. Cancellation
uses ExternalJob's existing keyed Cancel action, with single-attempt rollback.

Main deduplicated payload references during literal collection. Each occurrence
now gets its own input slot and Ref; supplier changes still re-key the compiled
consumer without re-keying producers. Existing persisted keys remain readable.
The existing draft refusal and inert rendering regressions pass unchanged.

The baseline regressed on the new occurrence-count assertion and retry attempt
numbers (all 1 instead of 1–4). The final regressions cover replay, cancellation,
expiry, typed errors, compiled consumer identity and repeated host invocations.

Validation:
- Node 26.5.0; frozen offline install passed, including the workspace test dependency.
- Flow: 950 passed across 73 files, 100% statements/branches/functions/lines.
- Engine: 617 passed, 100% statements/branches/functions/lines.
- Engine-store: full SQLite/Postgres matrix passed; 2,181 SQLite tests and 2,182
  Postgres tests passed. Two SQLite-leg connection-loss cases and one PgBouncer
  case in the Postgres leg skipped for absent listeners. Merged coverage is 100%
  statements/branches/functions/lines, with unchanged thresholds.
- Host and remote-job callers: 27 passed, using real engine layers and TestClock.
- MVP `pnpm exec tsc --noEmit`: passed before and after; no new failures.
- Flow source types, circular imports, changed-source lint/format and importRules passed.
- Flow test-file types retain four pre-existing errors in unchanged RetryPolicy.test.ts:657–658.
- Workflow types retain only the removed agent/fs imports in unchanged coding-builtin-routes.test.ts.
- Target index regenerated; site reference and llms projections refreshed and checked.
- Astra review approved. Fable is unavailable in the session's model inventory.

Commands: `pnpm exec vitest run --maxWorkers=1` in flow and engine;
`node ../database/scripts/test-matrix.mjs --maxWorkers=2` in engine-store with
`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` pointing to this clone's native helper;
`node --experimental-strip-types --test issue-sweep/test/host.test.ts issue-sweep/test/remote-job.test.ts`
in .smithers/flows; `pnpm exec smithers-build test '//packages/smithers/flows/flow:importRules'`;
`pnpm exec tsc --noEmit` in apps/mvp before and after.

Initial coverage attempts hit
ENOSPC; only this run's artifacts were cleaned. The native helper could not build
on the full disk, so the pinned platform-node npm package supplied its real
darwin-arm64 helper. The first storage matrix hit a foreign Postgres listener
without the smithers role during its SQLite leg; the clean full matrix passed.
No external scratch storage, Playwright, push or main movement.
