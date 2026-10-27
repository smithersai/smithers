---
title: W13 unowned production e2e failures
status: blocked
area: production-e2e
owner: codex-w13-followups
updated: 2026-10-27
links:
  - ../features/repo.md
  - ../features/bugs.md
---

Reproduce the assigned W13 privacy, device storage, flow editor, repository,
visitor, publish and code intelligence failures. Correct the product or the test
at its real cause, retaining the named behavior. Build and verify on Latitude;
production runs hold the shared e2e lock. No push or deployment.

Catalog: existing platform-browser storage and language server,
effect-tanstack-db collections, repo-view, observability failure records,
integrations GitHub client, and durable flow entries; no new library.

Branch opening now waits for the first identity answer before admitting branch
tracking. Its regression delays the injected session service and reads the real
signed-out server. Code intelligence retains a pending Symbols lookup when only
the repository's default-branch metadata changes; a stalled real shape makes
that race deterministic.

The e2e corrections retain the named checks: tab-local privacy records and a
positive failed-read record, an opened conversation fixture and exact offline row
identities, storage-capable browser profiles and private-session recording,
Clone layout at both widths, a real explicit failed clone, intentional sandbox
CSP denials, the current declared landing text, and Publish/Update receipts
from the accepted request's ID. GitHub verification uses the already-required
installation client; authorship and contents assertions are unchanged.

Latitude passed typecheck, import rules, lint, and 67 focused tests at 100%
statements, branches, functions and lines on all three changed runtime files.
The two product regressions failed on the previous implementation. Astra found
no actionable issues; Fable could not start because its accounts were cooling.

Production validation remains blocked. WebKit reports access-control errors
alongside canceled requests during document reload; the storage spec records
navigation and request-failure stages without suppressing those errors. The
missing-repository fixture initially received an upstream quota refusal; after
recovery it proved a real failed clone and another failed attempt after Retry.
The visitor's home can omit Docs despite an About response naming its index;
the visitor spec now records whether its actual About answer carries it.
After removing the exact test-owned broken home view, the final production
Publish journey passed, including Update, the second Publish and GitHub content
checks. Privacy, private-session storage, Clone layout and failed-clone Retry
passed in both production projects. Chromium passed both offline storage cases;
WebKit retains its pre-existing offline transport failure annotations. The
initial identity fix still requires deployment and a signed-out file rerun.
Local dev runs also retain their service-worker, identity and missing-service
limits. The visitor crowd test was not run under the no-load constraint.
