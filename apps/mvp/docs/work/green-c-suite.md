---
title: Finish suite failures and coverage in green-c
status: in-progress
area: testing
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links: []
---

Diagnose six load-dependent failures at 22c55343d6, fix each demonstrated cause, and cover remaining live behavior to the unchanged 100% gate. Execute all checks on the mini, including complementary full-suite shards and the four-project typecheck. Evidence and landing receipts are recorded in ~/smithers-builders/green-c-STATUS.md. Uses existing catalog entries @smthrs/flow, @smthrs/platform-browser and @smthrs/effect-tanstack-db; no new libraries.

RepoAbout: its persisted epoch deadlines and Retry-After calculations both use the application Effect clock; production never subtracts Postgres now(). The fixture subtracted the independent database clock. With the application clock held one minute ahead under four bounded CPU burners, the former query fails all three unchanged bounds (64946.515 > 5000; 119990.877 > 60000; 359986.410 > 300000). Reading raw timestamps against that held clock passes all 33 cases. No production clock correction is needed.
