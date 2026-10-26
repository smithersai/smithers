---
title: Bound stale issue reconciliation admission
status: done
area: worker
owner: Codex reconcile-admission
updated: 2026-10-25
links: [../decisions/0104-request-owned-worker-io.md, ../features/issues.md]
---

Completed the inherited request-owned admission fix: await the idempotent
`FlowStarter.start` call for at most 2 seconds, serve reads after timeout or
failure, and record each admission outcome with failure codes. Completed
bucket values are cached separately for each repository. No isolate scope or
`waitUntil`.
Catalog entries: `@smthrs/flow` via the existing FlowStarter and Reconcile,
`@smthrs/effect-electric` ShapeProxy, Effect Metric. No new dependency.

Latitude: typecheck, importRules, configured touched-file ESLint, and 223 tests
across seven focused files pass, including GitHubShapes under workerd.
Api.ts and Metrics.ts each reached 100% statements, branches, functions and
lines. Concurrent reads perform one real reconciliation walk and project its
issue into Postgres; the test host initializes before requests arrive.
The timeout regression fails with the former never-closed isolate fork and
passes after restoring request-owned admission.
