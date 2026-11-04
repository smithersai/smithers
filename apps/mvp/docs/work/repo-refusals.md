---
title: Repository refusal classification and page regressions
status: blocked
area: app
owner: Codex GPT-6 Astra (repo-refusals)
updated: 2026-11-04
links: [../features/repo.md, ../features/notifications.md]
---

Repair the production absent repository 503 without distinguishing absent from inaccessible repositories. Preserve retryable upstream failures and typed stage diagnostics. Keep one Connection region on repository pages and preserve headerless embedded homes. Move the visitor notifications regression to /app.

Tests precede fixes; all installation and validation run on the mini or run-heavy. No deploys in this lane.

Catalog entries: existing Effect HttpClient and @smthrs/integrations GitHub transport, @smthrs/ui repository home and ConnectionPill primitives. No new library or feature framework.

Validation: 319 server tests and six UI regressions pass across the affected-suite runs; the four-project typecheck passes. Baselines reproduced absent refs 503/204, metadata denial misclassification, repeated notification authorization, duplicate Connection regions and the missing refused-page notification controls. Astra and Fable reviewed the changes; their product and fixture findings were corrected.

Production verification remains blocked on the lead deployment and the shared test-account reservation. This lane waited 20 minutes without acquiring or breaking that lock. The local browser reservation also timed out. The visitor spec correction is committed for the next browser run; no browser success or whole-app coverage claim is made.

After integrating the concurrent empty-private-ref optimization, the full RepoApi and RefReads suites pass (74 tests), with typecheck passing again. The rate-limit diagnostic regression now seeds a private ref so it exercises the authorization it is meant to check.
