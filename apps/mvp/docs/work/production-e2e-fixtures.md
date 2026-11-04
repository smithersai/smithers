---
title: Production fixtures for run history and absent repositories
status: in-progress
area: app
owner: codex-e2e-fixtures
updated: 2026-11-04
links: []
---

Make run-records, undispatched-steps and repo-browse execute against production
with real test-account prerequisites. Prefer creating fixtures through the product;
retained runs must be selected and verified through its authenticated public API.
Verify repository absence at test time. Never fabricate engine history.

Libraries: existing @smthrs/flow and @smthrs/engine-store run inspection API;
Playwright drives the real product. No new library or product runtime.

Validation: production specs and apps/mvp pnpm typecheck (four projects),
using the Mac mini for compute. No deployment from this lane.

The prerequisite regression exposed an existing direct skip in machine-token.spec.ts.
Its token file now uses the declared machineToken need; no credential is read by
capability detection. Production media can delegate to a compute host through
E2E_MEDIA_RUNNER, retaining the real media validation exit status.

Production first run: 14 feature cases passed, six failed, zero skipped. Failed-history
and legacy undispatched coverage passed in Chromium and WebKit. Repository history
creation is blocked by the missing manual flow and production allowlist. Browse
failures exposed an unauthorized header fixture, UUID mismatch in deliberate-404
diagnostics, and unnecessary role lookup for empty ephemeral refs. The header
fixture now verifies a real Member role on an unimported test-account repository.
The absence journey now verifies recovery and no import; it no longer forces a
clone without repository authority to manufacture a failure notification.
GitHub missing metadata remains unknown visibility under the existing privacy
policy; this change never treats it as private or grants clone authority.
