---
title: Bring the held device privacy stack to ready-to-land
status: review
area: local-first
owner: Codex
updated: 2026-11-04
links: [../decisions/0023-device-ownership-and-queued-authority.md]
---
Rebase the local dependency patch and never-drop 401 client change onto current
main, include the held step 1b server change, and compare the affected app and SDK
suites by failing name on cfbox. Obtain exact-diff review receipts. Do not land,
push, deploy, or run heavy work locally. The catalog entry used is
`@smthrs/effect-tanstack-db`; chat delivery now lives in `chat/writes.ts` on main,
so its hold and dependency keys move there with the existing regressions.

Original client: ee094bec. Original dependency patch: 5fff6bc8. Original step 1b:
6ec1653b. The patch remains its own bottom commit and retains the existing entry
in the private UPSTREAM.md tracker. Original test-first commits remain in jj
history and the earlier work notes retain their red evidence.

Astra client review 01a1a876-2f45-7d82-a770-84b8ed91b318 found two bugs.
The cfbox `client-red` run executed three new regressions and failed all three:
real runtime disposal stranded sign-out before its retry action, an internal
401 confirmation resent early, and expired-gate verification reread too early.
Shutdown now runs outside the sign-out finalizer while the page stays sealed;
all stale credential responses share serialized Retry-After persistence.
The regressions use a real local HTTP server, native Web Locks and a real Effect
runtime. Raw run artifacts and exact revision IDs live in the coedit401 runner
directory. The `client-green` cfbox run passed all 72 wipe and identity tests with zero
skips. Readiness requires the retained full-suite comparison and exact-diff
review receipts.

Client review 01a1a88d-37fc-79d2-bd0a-a0f786c4fe7b found lost privacy-gate
classification and a lost local deadline after storage-write refusal. The
`privacy-red` cfbox run failed all four new cases before their fixes and passed
typechecking. `privacy-green` then passed all 105 tests across credential privacy,
identity, wipe, auth and repository visibility, with zero skips. The regressions drive boundFetch, real HTTP, AuthClient, auth load
and the real collection data gate, plus absent and already verified credential
records with an injected storage-write failure. AuthClient now preserves the
credential-stale classification; failed publications retain a local hold and are
published by later outbox-driven attempts before any further send.

Client review 01a1a8a1-a576-76e3-bde4-0aa2c97311a8 found that slow
publication could become a generic session timeout before the privacy gate
learned of the stale response. `privacy-delay-red` failed both stalled-storage
and stalled-lock regressions at the unverifiable-row assertion. Reporting the
observed refusal now happens immediately; one serialized publication continues,
with the local hold blocking later writes until it completes. The real HTTP and
collection-gate regressions also cover a subsequent network failure and a fresh
session answer, without releasing the stalled publication first.

Client review 01a1a8b2-f708-78d3-a6b8-b2aa446ce707 found that a successor
could bypass another transport's unpublished hold. `successor-red` reproduced
both lock and storage stalls: a second transport sent one HTTP write before
publication completed. Write-gate reads now take the shared credential lock,
including the final revision check after owner verification. The regressions
also require the exact deadline and a matching owner before the successor sends.
