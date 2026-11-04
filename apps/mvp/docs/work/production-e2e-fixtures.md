---
title: Production fixtures for run history and absent repositories
status: blocked
area: app
owner: codex-e2e-fixtures
updated: 2026-11-04
links: []
---

History and absence prerequisites are resolved through the test account's real
product APIs. Failed history is selected and inspected at execution time;
repository history is selected or created with the scratch repository's manual
flow. The legacy undispatched recording is explicitly configured and verified.
GitHub verifies each absent name before About; preview and mirror 404s are
scoped to that exact verified fixture. No journal records are inserted.

The Clone layout fixture now verifies repository membership and no existing
mirror. The absence journey checks recovery and no import rather than forcing
a clone without authority. Empty private-ref sets no longer ask GitHub for an
unnecessary role; populated private refs still fail closed. The regression uses
real Postgres and an injected faulty Effect role service.

Libraries: the existing @smthrs/flow and @smthrs/engine-store inspection APIs;
Effect SQL and existing branch authority services; Playwright's real boundaries.
No new library or product runtime. The machine-token test now declares its
existing prerequisite. Media may run on a compute host, retaining its exit gate.

Validation: all four ES2022 typecheck projects and 99 focused tests passed on
the Mac mini. Coverage was not collected for that focused run. The latest
production run executed all three specs in Chromium and WebKit: 16 passed,
four failed, zero skipped. Failed-history, undispatched work and the corrected
Clone layout passed in both browsers. Sign-in was verified before omitting
unrelated model setup from the last metadata-only run; the configured model's
failed Test is retained separately.

Blocked: production must deploy the empty-ref fix. Both missing-repository
cases currently fail on the old refs endpoint's 503. Repository history also
needs the real manual hand fixture on the test scratch default branch and
production REPO_FLOWS/REPO_FLOWS_REPOSITORIES configuration; its flow listing
currently answers not_found and no retained repository execution exists.
The lane does not deploy or alter production configuration.
