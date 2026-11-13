---
title: Chat component regression fixes
status: done
area: ui
owner: codex-mini-ui-chat-476629
updated: 2026-10-21
links: [../../../../packages/smithers/ui/docs/chat-timeline.md]
---

Reproduce the four reported composer, timeline and completion-list bugs in this
isolated clone. Use the library catalog's `@smthrs/ui` entry and existing Bun
component tests. No new dependencies, pushes or browser end-to-end runs.

Fixed read-only keyboard/pointer completions, callback-driven timeline update
loops, and the desktop override that removed the flex layout. The callback ref
updates at commit in a layout effect; subscription identity depends only on
entry ids and callback availability. Completion callbacks remain host-owned and
no new actions were added.

Validation (Node 26.5.0, Bun 1.4.2):

- `pnpm install --frozen-lockfile --offline` failed on missing cached
  `@astrojs/check` metadata; the retry without `--offline` succeeded.
- Before fixes, `bun test tests` in `packages/smithers/ui`: 2,560 passed,
  four new regressions failed. Read-only input invoked choose/highlight/dismiss
  callbacks, the inline group callback ran four times instead of once, and the
  desktop declaration resolved to `block` instead of `flex`.
- After fixes, the two affected test files: 26 passed, zero failed.
- After fixes, `bun test tests`: 2,565 passed, zero failed across 179 files.
- `pnpm --filter @smthrs/ui check`: passed.
- Astra review caught late callback enablement; its additional regression failed
  before the availability dependency was added and passes after. Follow-up Astra
  review found no remaining concrete correctness concerns.
- Ancestor completion scrolling: not reproduced or changed. The real component
  probe returned ancestor scrollTop 40 unchanged, list scrollTop 0, list
  clientHeight 0 and last-row top 0. Happy DOM has no layout and implements
  `scrollIntoView` as a no-op, so a no-mock failing regression needs a browser.
- E2E (Playwright): not run (mini clone).
