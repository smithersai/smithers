---
title: Repository Markdown parity
status: done
area: repo-view
owner: bb2-markdown
updated: 2026-10-26
links: [../features/repo.md]
---

Library catalog: @smthrs/repo-view and @smthrs/ui.

Fixed sanitized HTML/comments, YAML metadata, phone tables, code colors, alerts,
badge names and list continuations. Each fix has a changeset and regression.

Production probes reproduced the findings before changes. Hyphens are ASCII
in a system monospace font; installation fences are contained, scrollable and
keyboard-focusable with Wrap off. The maintainer fixture's status.svg already
exists on main; the fixture and queue test agree.

Latitude: UI 2,668 tests; repo-view 184 tests; changed files at 100% lines and
functions. App and SDK typechecks/import rules plus app lint pass. W10 source
fails nine new regression tests. Bun's coverage report does not measure
branches or statements separately; no claim is made for those metrics.

Deployment validation remains for the lander: run e2e/markdown-rendering.spec.ts
on the pushed deployment, including the 390px table and viewport-mounted code
preview. The Mac mini is unavailable; no deployment was attempted here.
