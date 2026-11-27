---
title: Keep spend alerts and personal decisions in chronological order
status: done
area: notifications
owner: codex-notifications
updated: 2026-11-27
links:
  - ../decisions/0036-toasts-reserve-page-space.md
---

The production bell showed 113 model-spend entries ahead of all four other entries. None of the four was a personal approval. The panel rendered every spend window before the personal feed and gave each the same tone as a waiting question. Decisions 0008, 0009 and 0036 require an alert on any use, a chronological panel, and focus on the person’s newest visible wait. Each stored model-spend window has at least one admitted call. Zero tokens or a zero charge leaves that receipt intact.

The panel combines the two existing live queries by time, shows model spend as an update and reports the call count when tokens are zero. It opens at the newest personal wait permitted by the current data gate. An empty history reaches the existing empty state. The release requires no migration or changes to acknowledgments, notification counts, the model ledger or channel delivery. Catalog entries used include `@smthrs/ui` for the panel, rows and timestamps, and the existing `@smthrs/effect-tanstack-db` live queries.

The Mini passed 174 notification, spend and producer tests, then all five app typecheck projects and 27 final tests, including the routed panel over Postgres/Electric, a hidden repository’s wait, empty history and equal timestamps. Chromium opened the real bell with 113 stored zero-charge alerts and one synthetic personal question. All 114 rows remained visible in chronology. The question between two windows took focus and expanded. The production account was untouched.
