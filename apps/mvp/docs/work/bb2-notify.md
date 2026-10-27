---
title: Notification destinations and header status
status: done
area: notifications
owner: bb2-notify
updated: 2026-10-27
links: []
---

W12: reproduce N1–N7, fix notification destinations and clarity. Catalog: @smthrs/ui for shared notification and status views; existing Effect collections and TanStack Router for actions and navigation. No new libraries.

N1: commit entries open their recorded revision, including persisted home links.
N3: failed clones keep their reason and Retry in the panel; no dead Open destination.
N4: timeline previews format database timestamps for the viewer.
N5: the failed header links to the answer's run.
N6: rows open their subject; Details/E expand; failure uses ! instead of a dismiss-like cross.
N7: not a bug: production held 343 rows in an independently scrolling list, including all unread entries.
N2 belongs to branch creation and is outside this notification change.

Latitude: app typecheck, importRules and lint pass; 59 focused tests pass; actions.ts, entries.ts and timeline/view.ts reach 100% in all coverage metrics. UI typecheck and 2,664 tests pass; NotificationPanel.tsx reaches 100% lines/functions (Bun does not report branch/statement coverage). App TSX coverage is excluded by the existing configuration. Five app assertions and both UI regressions fail on the original main source.

Deployment verification remains with the lander: run notification-destinations.spec.ts, notification-overflow.spec.ts, notifications.spec.ts and status.spec.ts. Use real member history for commit, failed clone, failed answer and timeline checks; run local-only seeded header/scripted-model cases separately. No deployment, mini run or GIF was performed.
