---
title: Keep Electric warm through a scheduled durable flow
status: todo
area: infra
owner: unassigned; lead plans after CI scheduled flows exist
updated: 2026-10-22 07:44 PDT
links: [production-shape-concurrency.md, production-branch-page-performance.md, ci-parity-cron.md, everything-is-a-durable-flow.md, ../rulings.md]
---

**What:** Keep the live-data service warm with a scheduled Smithers flow.

**Why:** The proposed six-hour idle window still permits a cold restart after a longer quiet spell.

**Current state:** At 07:42 PDT the lead proposes this follow-up once CI scheduled flows exist. The immediate six-hour-window repair is separately queued to land. No keep-alive implementation or execution receipt is reported.

**Next step:** Use the scheduled-flow capability when available, add observable durable execution and prove loading after more than six hours idle. No hand-written timer loop; consult docs/libraries.md before implementation.

**Open questions for Will:** None newly required; schedule and acceptance details remain engineering choices.

Evidence: script-extracted lead reply at 2026-10-22 14:42:38 UTC, checked against DUR-1–3. This is a lead plan, not a new ruling from Will.
