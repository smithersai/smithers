---
title: Component library correctness and accessibility
status: done
area: ui
owner: codex
updated: 2026-11-13
links: [https://github.com/smithersai/smithers/issues/5008]
---

Fix the ten findings in issue #5008 through the catalog's Render UI entry,
`@smthrs/ui`. Keep the public compound component APIs.

Regressions cover rounded duration units, terminal test progress, compound
suite names, calendar rows and event controls, overlapping events, overflow
clicks, source lists, accessible change summaries, singular counts and tool
state announcements. Property tests cover duration boundaries and calendar
overlap groups; Chromium checks real hit boxes and accessibility roles.

Validation:

- The new regression suite failed 22 tests on the unmodified base.
- `bun test tests --coverage`: 3,078 passed; the new duration and overlap
  helpers have 100% function and line coverage.
- `pnpm run check`: source and test typechecks passed.
- `node --test scripts/reference-docs.test.mjs`: passed.
- `smithers-build test //packages/smithers/ui:importRules`: passed.
- `bun test browser/component-library.browser.test.ts`: three passed in
  Chromium, including disjoint link hit boxes and overflow click isolation.

Regenerated the sandboxed presentation bundle from its component sources.
The package declares no ESLint or dprint gate.

Retained the existing terminal-status progress fix when reconciling concurrent
changes; the complete package and browser gates passed on the combined tree.
