---
title: Keep plugin live snapshots stable between changes
status: in-progress
area: plugins
owner: Codex GPT-6.1 Sol (e2e-webpage)
updated: 2026-11-04
links: [../features/plugins.md, ../../src/plugins/liveQuery.test.ts, prod-web-pages.md]
---

The local external-page suite reproduced React's uncached `getSnapshot` warning
and maximum update depth error in Queue's `NavCount` on every journey.
`liveQueryOf.current` returns TanStack's freshly allocated `toArray` on every
read. The hidden repository adapter also allocates a fresh empty array.

Keep unchanged snapshots stable while reading the gated query synchronously,
so permission refusals still hide rows before the rows stream catches up.
This fixes the app's existing implementation of the public `@smthrs/plugin`
`Host.Live` contract (library catalog: plugin manifests and host), without
adding a plugin-specific interface or another state store.

Regression: real TanStack collections and the real repository visibility gate;
unchanged empty and populated reads, changed rows, deletion, refusal and restore.
Existing browser error records pinpointed `NavCount`; they remain enabled.

Validation: the new regression fails the original uncached reader at its first
snapshot identity assertion. With the fix restored, all nine snapshot, fleet
and repository visibility tests pass, followed by all four ES2022 app typecheck
projects, on Node 26.5 with the real Postgres test image through `run-heavy`.
Codex Astra reviewed the implementation and regression without findings.
The local browser rerun and production verification remain pending shared
test capacity; deployment belongs to the lead.

Fable confirmed the snapshot logic and identified shared-array mutation by an untyped consumer. The follow-up freezes the empty sentinel and adopted snapshots; the real-collection regression attempts mutation, requires rejection and verifies unchanged reads before normal updates and permission changes. Follow-up validation: 9/9 focused tests and all four typecheck projects pass on Node 26.5; Fable re-review has no findings. Caller audit confirms mutators operate on copies or derived arrays.
