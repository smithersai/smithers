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


A cold install exposed Alchemy's undeclared type dependency: the app resolved @cloudflare/workers-types 5.20261019.1 but Alchemy resolved hoisted 5.20260903.1, whose ContainerStartupOptions omitted basic. Cloudflare's documented contract still supports basic (https://developers.cloudflare.com/containers/platform/limits/). The pnpm package extension gives Alchemy the app's exact existing declaration dependency, preserving the SDK contract and runtime behavior. The lock is regenerated on the mini; dependency resolution and all four projects validate it. Library catalog entry: @smthrs/platform-cloudflare, the container host.

Real-device coverage found that selecting a visible rail message widened a two-message window to three. showMessage now returns when its selected row is already in the current window; older rows still widen history with a page of margin. The regression failed with 3 versus 2 before the fix. A long Unicode fleet title also exposed clipping through a surrogate pair; clipping now drops a trailing unmatched high surrogate before its ellipsis, with both odd and even prefix lengths exercised against real Postgres rows.
