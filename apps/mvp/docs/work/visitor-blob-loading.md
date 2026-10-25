---
title: Visitor file pages wait for repository sync
status: blocked
area: app
owner: Codex builder blob
updated: 2026-10-25
links: [../features/repo.md, ../features/navigation.md]
---

A signed-out direct visit to `/smithersai/vibelang/blob/main/README.md`
reproduces the grey pane on production revision `a0a126492c`.
Stopped at diagnosis under the assignment's instruction to report an architectural cause.
No fix, new e2e, or passing validation is claimed.

## Evidence

The supplied factory record D2/D15 records a blank file page, successful session
resolution as signed out, branch tracking and run-credential requests refused
with 401, and no page exception. A fresh Chromium probe confirmed:

- About and Home each return 200.
- At 11.2–15.3 seconds after navigation, the body is
  `.sui-skeleton.repo-page-loading`, measuring 1408 by 764.5 pixels in a
  1440 by 900 viewport. It is an unresolved repository view, not an empty file
  or a Markdown renderer exception.
- Home has `aria-current="page"` and `data-status="active"`; Code also has
  `aria-current="page"`. TanStack's prefix match supplies Home's active state,
  while `HomeTabs` supplies Code's explicit current state.
- A separate longer visit receives 200 for tree, README, generated manifest
  and refs at the stored clone's head `962226c71a6e8415e02ea7b4d55ea0ab2cff6ce9`.
  The README then renders headings and code blocks. Thus the symptom is a long
  initial wait, not proof that the file endpoint or renderer always fails.
- Both visits make unnecessary signed-out branch and run-credential requests.
  Their refusals do not prevent the later successful file read.

## Dependency causing the wait

`src/features/repo/actions.ts`'s `warm` waits for `shownRepository`, which awaits
repository collection preload. Its page deadline ends warming, but `open` then
starts `load`, which calls `ready` and waits indefinitely for a ready repository
row from the same Electric collection. No tree or file read begins until that
row supplies its head. `RepoPage` also reads a live query joined to that
collection, showing the full-pane skeleton until it can project the view.
About's successful independent public read does not satisfy either dependency.
The branch tracking refusal is a separate result, and does not supply the row.

This couples an immutable public file read to completion of repository-wide
synchronization. Repair requires deciding how file-location resolution proceeds
when sync is slow, absent or failed, including repositories without a ready
clone. The existing refs endpoint supplies a cloned repository's default branch
and head; About supplies a public GitHub head. They are different sources and
must not silently substitute for one another or falsely claim a clone exists.
No speculative fallback, timeout-based retry, or synthesized clone row was added.

The next implementation should separate public file-location resolution from
clone synchronization, retain truthful refused/missing outcomes, instrument the
repository-wait and location-resolution stages without content or credentials,
and add a fresh visitor e2e covering rendered Markdown, highlighted source,
exactly one active Code tab, and no needless signed-out writes. The first
regression must hold repository sync unresolved through an injected Effect
service while public reads complete; production e2e alone cannot force that race.

Catalog entries reviewed: `@smthrs/effect-electric`,
`@smthrs/effect-tanstack-db`, `@smthrs/repo-view`, and `@smthrs/ui`.
