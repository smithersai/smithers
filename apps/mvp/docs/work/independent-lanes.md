---
title: Independent lanes (G2 slice S4)
status: in-review
area: todos
owner: claude-s4-lanes
updated: 2026-10-31
links: [docs/decisions/0132-independent-lanes.md, docs/features/todos.md#lanes]
---

A repository runs up to 64 TODOs at once, each stacked on the TODO it names (`todos.after`) or independent; the
repository's `stacks.base` sets the default (decision 0132). Built: migration `0076_independent_lanes`, the fill,
leave and retry rules with property tests, the writer and route (`after`, Admin `configure`), base selection and
descendant invalidation by `after`, `todos.waiting` with "Waiting for a runner", `After T<n>` on rows and pages.

Left:

- `e2e/todos-independent.spec.ts` "ten at once" needs a run host: a live instance with the App on a scratch repository
  now, or `alchemy dev` with S1's runner and ACP test agent once S1 lands.
- S1's `agent/Session` reports `{ kind: "waiting", waiting: "runner" }` while its job is queued, and `null` on claim.
- After deploy, VibeLang's Admin sets `independent`, 52 lanes, 200 open (`op: "configure"`).
- A draft control for `after`, and the settings in a repository's Settings.
