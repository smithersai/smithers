---
title: Run and flow navigation bug bash
status: in-progress
area: app
owner: Codex bb-runs
updated: 2026-10-26
links: [../features/runs.md, ../features/flows.md]
---

Reproduce production findings for run history, stopped steps, repository runs,
flow access, and narrow screens. Each fix retains a regression test.
Use the library catalog's UI and loading entries (`@smthrs/ui`) and existing
run inspection through the browser engine and gateway; no new libraries.

## Handoff

- Fixed: visitor sign-in on Flows and repository Runs, the `/flows` redirect,
  stopped steps and clocks, cold run content loading, and repository/flow identity.
- Not a bug: the linked local run belonged to another fresh browser context.
  Creating `watch/set` and opening it in the same production context rendered its
  steps and result without failed requests. The supplied old id correctly says
  On another device; the exploratory remote fallback returns 404.
- Not a bug: personal saved flows differ from system and repository flows in Runs.
  The production personal flow list populated on the repeat probe.
- Signed-in repository Runs reached No runs yet on the repeat probe; the visitor
  gate was the reproducible permanent blank state.
- Deferred: the phone table's missing scroll cue. Native horizontal scrolling
  reaches Branch and Actor without page overflow; changing the mobile presentation
  is not needed to inspect those columns.

Production was probed again after implementation; it still runs the old code.
The lander must deploy, rerun the visitor/alias specs, and check the reported
stopped TODO and CI run: Stopped with fixed step durations, a repository link,
and the title ci after the graph arrives. Cold inspection must show the shared
skeleton before the graph. The Mac mini was unavailable; no local browser run
or deployment is claimed. Regenerate SDK documentation/API artifacts when landing.

Latitude: the 20 focused app tests pass; graph logic and the changed screen
components have 100% lines, branches, statements and functions. The full UI
suite passes (2,662 tests); its touched files report 100% lines and functions.
The current regression tests also fail against the W10 source for all six fixes.
RunPageView and the router are outside the app's default TypeScript-only coverage
include; the loaded/cold view and redirect are tested, but full-file coverage for
those two TSX modules is not claimed.
