---
title: Request only the shapes a person and page read
status: in-progress
area: mvp
owner: electric-s2
updated: 2026-10-26
links: [../decisions/0112-shape-demand.md]
---

Step S2 of the Electric-at-scale plan. `ShapeSource.gated` (`@smthrs/effect-electric`) holds a collection's requests until a condition holds. Personal shapes and triage settings wait for sign-in; a pull request's commits, reviews and checks wait for its page. Proof: `src/features/auth/source.test.ts` and `e2e/shape-demand.spec.ts`. Library catalog: @smthrs/effect-electric and @smthrs/effect-tanstack-db.
