---
title: Gate repository shapes by device authority
status: in-progress
area: mvp
owner: signed-out-shapes
updated: 2026-10-25
links: []
---

Gate all eight repository shapes before opening requests. Access comes from the session and repository role answer, including explicit public read authority. Library catalog: @smthrs/effect-electric and @smthrs/effect-tanstack-db.

Proof: Latitude typecheck and import rules pass; issues/pulls and public-role handler: 98 tests, 100% coverage; TODOs: 72 tests, 100% coverage. All three store regressions fail on the unchanged base with actual unauthorized request lists. Mini cold-home and mobile checks are queued behind the shared e2e lock. Decision 0110 records the policy.
