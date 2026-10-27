---
title: Bug bash 4 — review and view recovery
status: ready-for-landing
area: views
owner: codex-bb4-views
updated: 2026-10-27
links: []
---

Assigned findings: p4-pr-review-1, p4-todos-1, p4-todos-3, p4-big-2,
p4-reduced-2, p4-reduced-3. Reproduce W11 before changing code; preserve W12's
nearby fixes. One commit per finding with regression and deployment e2e coverage.

Catalog entries: `@smthrs/ui`, `@smthrs/repo-view`, `@smthrs/flow`,
`@smthrs/effect-tanstack-db`, `@smthrs/effect-electric`, `@smthrs/integrations`.
No new dependencies. Latitude supplies validation; deployment checks belong to
the lander. No push, deploy, or GitHub writes.

W11 probes reproduced false PR absence, the early empty stack (slow network),
undispatched Failed steps, missing oversized Download, and both native minimum
font overflows.

- p4-todos-1: W12 `d0572f077e67` already waits for the applied TODO shape;
  retain its implementation and `stack-direct-load` regression.
- p4-reduced-3: W12 `a28e33a1d2c8` already fixes the protocol tracks. Applying
  its exact rules to the native 20px repro yields a 640px page and 296px selectors
  whose contents also measure 296px. Added a deployment regression, no duplicate CSS.
- p4-todos-3: explicit empty dispatch evidence yields Skipped with zero attempts;
  the engine's dependency failure remains in the journal and replay stays causal.
  The shared skipped graph state overlaps W12 `1a1f90d08eef` identically.
- p4-reduced-2: the existing mark becomes bounded SVG geometry; no font-size
  fitting dependency. Shared UI suite passes; original renderer fails its regression.
- p4-big-2: same-origin attachment streams original bytes through the SDK,
  preserves the filename, keeps the preview cap, meters bytes including failed
  streams, and never buffers or caches a full download.
- p4-pr-review-1: authorized detail shapes recover one PR through durable Apply;
  only per-item absence fences can settle Not found. Old/misdirected receipts
  cannot change the routed absence state. Admission has a deadline and metrics.

Validation on Latitude:

- Typecheck, import rules and lint pass. The final focused app run passes 468
  tests; seven live-provider cases declare their unavailable prerequisites.
- Download/repository suites pass 118 tests. Every changed app logic file reaches
  100% statements, branches, functions and lines across the focused receipts.
- Receipt diagnostics pass 34 handler tests and 100% coverage on PullRefresh.
- Code Storage passes lint, typecheck and its complete suite: 193 passed, one
  live-provider prerequisite skipped; all configured coverage metrics are 100%.
- UI passes typecheck and 2,663 tests. Changed UI files reach 100% lines and
  functions; Bun does not report statement or branch coverage.
- Old run projection, file links, wordmark renderer and PR route each fail their
  regression before the fix. The PR regression exercises the real HTTP handler,
  Postgres/Electric and durable host. Third-party fixtures remain Effect services;
  deployment specs use real providers without request interception.

Lander: include the W12 dependencies above, regenerate SDK artifacts, run the
full app suite and required reviews, then the production specs `pull-recovery`,
`undispatched-steps`, `large-file`, `minimum-font`, `minimum-font-settings` and
W12's `stack-direct-load`. No changed-build production E2E or GIF is claimed;
the mini is unavailable and this builder must not push or deploy.
