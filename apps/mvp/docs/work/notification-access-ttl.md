---
title: Reuse recent notification repository decisions
status: done
area: notifications
owner: codex-notif-gate
updated: 2026-11-04
links: [../features/notifications.md]
---

Fix repeated signed-in feed authorization taking 17–20 seconds. Use the existing
Effect SQL and catalogued `@smthrs/effect-electric` shape proxy; no new library or
plugin interface. Preserve emit-time authority and denial-sequence fences.

Validation on the Mac mini:

- Red: eight new access regressions failed against the original gate.
- Green: `pnpm vitest run worker/Notifications.access.test.ts worker/Notifications.test.ts --coverage.enabled=false` — 110 tests passed, real Postgres and Electric. Faults/counters are injected Effect services.
- `pnpm typecheck` — all four projects passed (ES2022).
- ESLint for `worker/Notifications.ts` — passed; test files are excluded by the repository's lint configuration.
- V8 coverage of the changed code: 30/30 statements, 10/10 functions and 8/8 branch outcomes, matched against added locations in `jj diff --git`; all file lines also execute. The two suites' whole-file report is 99.68% statements, 98.10% branches, 100% functions and 100% lines. Its unchanged uncovered sites are lines 187, 282, 576 and 739; the configured 100% whole-file threshold still reports failure. No threshold configuration changed.

Reproduce the controlled timing with the 36-cold-repositories test in
`worker/Notifications.access.test.ts`: real Postgres/Electric, two seconds of
latency injected through the real local-development BranchRoles service. Before:
18,176 ms cold, 18,199 ms warm, peak concurrency 4 and 36 warm resolver calls.
After: 6,106 ms cold, 42 ms warm, peak concurrency 16 and zero warm resolver
calls. These are controlled fixture measurements, not live GitHub or deployed
latency claims. Sixteen limits a cold read to three resolver batches rather than
nine. Emit-time authority and the original denial fences remain unchanged; even
a reused denial cannot adopt a newer fence while another repository resolves.

The shape proxy/access layer has no 17-second authorization deadline. Its
intentional access/fence/replay refusals stay fail-closed. Production deployment
and smoke testing belong to the lead; this lane only pushes the fix.
