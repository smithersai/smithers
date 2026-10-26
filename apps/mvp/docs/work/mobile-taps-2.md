---
title: Remaining mobile tap targets
status: done
area: mobile
owner: Codex mobile-taps-2
updated: 2026-10-26
links: [../features/notifications.md]
---

Use the library catalog Render UI entry, @smthrs/ui control-height tokens.
Keep one bell per route, reserve its row on pages without a header, enlarge
outside links without enlarging text, and keep branch Home tabs inside the scrollport.
Gateway overload and asset failures remain visible in the strict browser audit.

Latitude: final typecheck and importRules pass; 41 focused tests pass, with
100% statements, branches, functions and lines for the changed attention contract.
The shared UI suite passes 2,662 tests. Restoring old product styles/routing
fails nine focused regressions; current product passes all 41 tests.
The mini remained occupied by another full e2e run; the queued request was
cancelled without touching its lock. Production after-counts and isolated
persisted-view/flow-draft checks remain unverified. No production run was made.

Landed with e2e-baseline (lander W6, 2026-10-26): the bell routes, the issues
GitHub link, the announcement and the signed-out Sign in keep e2e-baseline's
fixes, which apply at touch widths only (`e2e/mobile-baseline.ts`). This work
adds the branch Home tabs fix and the browser test, whose size check runs at
touch widths (960 px and below), like `mobile.spec`'s tap-target audit.
