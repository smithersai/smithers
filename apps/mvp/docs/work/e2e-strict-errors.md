---
title: Every e2e test fails on server, console and page errors; production health spec
status: in-progress
area: testing
owner: e2e-strict builder (lead session smithers-86)
updated: 2026-10-25 21:50 PDT
links: [production-e2e.md, ../infrastructure.md, ../rules.md]
---

## 2026-10-25 21:50 PDT

**What:** Every e2e spec fails on a response of 500 or above from the app, a failed `/api/` request, a console error or a page error it didn't declare (`e2e/watch.ts`, `e2e/problems.ts`). `e2e/health.spec.ts` cold-loads `/` and both repositories in eight browsers at once, signed out and signed in, and is the first check after a deploy. The engine worker's `engine-store.registration.recovered` logs once per engine start instead of about 446 times.

**Why:** Will, 2026-10-25 18:50: "Please make sure we are testing production works." His console on smithers.sh showed shape reads answered `500` (60 to 600 an hour since 10-24) that no spec failed on, because the browser retries a failed shape and the specs checked only what rendered.

**Current state:** Written, unit-tested at 100% on the pure modules, and run once in full on the Mac mini (462 tests: 145 failures predate the check). Under the final rules the check fails 77 more tests:

- 71 are one product defect: signed out, the app syncs eight member-only shapes (`items`, `comments`, `github-sync`, `triage-settings`, `pulls`, `pull-commits`, `reviews`, `checks`) on every page, including `/`, and each answers `401`, a console error in every visitor's browser. The issues and pulls stores (`src/features/issues/store.ts`, `src/features/pulls/store.ts`) start them eagerly and learn access from that `401` (`accessOf`). Specs: `mobile.spec.ts` (66 signed-out screens), `sign-in.spec.ts` (2), `health.spec.ts` (`/`, signed out), `issues.spec.ts` (1), `vibelang-visitor.spec.ts` (1).
- 4 are bursts of local `502`s where the mini's workerd reset every open connection at once (`Worker request failed: read ECONNRESET` in its dev log, no reload): `branch-load`, `branch-sharing`, `model-quota`, `repo-in-chat`.
- 1 is test data: `mobile.spec.ts` "view: a persisted page" posts a `webpage` view of example.com straight to `/api/views`, skipping the `/web` check that would store a card for a site that refuses framing; Chrome refuses the frame.

A person who can't read a shape gets the same treatment signed in: `403` on `alert-channels`, `alert-deliveries` and `sandbox-limits` (`sign-in.spec.ts` "a signed-out follower"). A second, targeted run on the mini also saw Electric answer `503` to first shape reads after about 6 s (`repositories`, `views`, `messages`, `message-pins`, `runs`; the dev log's `repo.shape` lines, upstream `electric`), once per fresh browser, in most tests; the first run didn't, so its cause is open.

**Next step:** Fix the signed-out shapes: the two stores take access from the session instead of a `401` (feature owner). Land; run `health.spec.ts` against production.

**Open questions for Will:** None.
