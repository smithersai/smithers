---
title: Issue and pull request bug bash
status: blocked
area: issues
owner: bb-issues
updated: 2026-10-26
links: []
---

Reproduce the October 26 issue, pull request, mobile loading and missing-repository findings on production. Fix each independently with regression coverage; validate on Latitude and hand the bookmark to the lander. Libraries: @smthrs/ui, @smthrs/effect-tanstack-db and @smthrs/effect-electric from docs/libraries.md.


Implemented seven isolated fixes: detail/list navigation and retained PR headings; visitor comment sign-in; cold list status; missing/unavailable repository action gating; attribution without an invented account; item-scoped persisted bodies/comments; creation receipt navigation with reload recovery and stale-submission protection.

Production probes before and after editing still exercise W10. Issue 4432 first content took 8.33 seconds before and 8.64 seconds after; PR 4436 Checks took 7.68 and 8.53 seconds. A diagnostic cold issue load rendered the app at 2.82 seconds but started shapes at 5.19 seconds, downloading 8.24 MB of item bodies and 19.46 MB of comments for one item. The new server-owned item filter addresses that payload; it preserves repository authorization and independent persisted cursors. Cold lists showed a bare header at about four seconds. All six new browser regressions await deployment; there is no claim of an end-to-end pass on the changed build.

Phone file loading remains deferred: boot rendered at 2.74 seconds, while tree/blob requests began at 5.60 seconds and responded in 34/27 ms. The remaining delay is startup and route prerequisites, not file transfer. Historical issue bodies containing @unknown remain unchanged; new writes now omit missing requester attribution. A missing repository's About 404 is the necessary authoritative absence receipt; the regression declares exactly that status, never a 503.

Latitude: typecheck, importRules and lint passed. The frontend focused run passed 156 tests with 100% statements, branches, functions and lines for its changed logic files. A further 346 tests passed, covering final issue actions, repository view, attribution and Write at 100%; The final 204-test API run passed with Api.ts at 100% in all four dimensions; ItemShape and Write also reached 100% in focused runs. Final typecheck and lint passed. Against original W10, the new attribution, creation-receipt and scoped-detail assertions all failed; the missing-repository assertion also failed before its fix.

Lander: deploy, run item-navigation, issue-visitor, issue-list-feedback, missing-repository, item-shape-payload and issue-create-navigation specs. Creation writes only to the scratch repository. Check issue/PR request URLs carry number, responses contain only that item, lists stay responsive, creation survives reload, and Checks/Commits retain heading/backlink. No mini run was possible; no deployment was authorized for this builder.

Handoff status: implementation validated on Latitude; blocked on lander deployment and production E2E, with phone startup deferred as measured above.
