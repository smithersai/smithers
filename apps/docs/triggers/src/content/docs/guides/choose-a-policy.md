---
title: "Choose an overlap and catch-up policy"
description: "Pick the two policy values on a trigger declaration by answering two questions about the flow: what a late boundary means, and what the flow owes after downtime."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/triggers/docs/guides/choose-a-policy.md"
---

Every trigger declares an `overlap` and a `catchUp`. Neither has a safe
universal default, so the declaration answers two questions about the flow
itself. The model behind them is in
[Overlap and catch-up](/concepts/policies/); this page is the decision.

## Question one: a boundary arrived and the last run is still going

Ask what a second concurrent run would do to the world.

**Choose `skip` when a late run is worthless.** A health check, a cache warm, a
metrics scrape: if the 03:00 run is still going at 04:00, the 04:00 run has
nothing to add. This is the default.

```ts
const healthCheck = { overlap: "skip", catchUp: "none", maxCatchUp: 0 }
```

**Choose `buffer-one` when the work must happen, but once is enough.** A
reindex, a digest, a sync: if you skip the boundary you lose the update, and if
you queue every boundary you get a pile of redundant work. The buffer holds one
occurrence and coalesces to the newest, so a run that overran four boundaries
leaves exactly one to do.

```ts
const searchReindex = { overlap: "buffer-one", catchUp: "one", maxCatchUp: 1 }
```

**Choose `supersede` when only the newest input matters.** A live dashboard
refresh, a preview build, a recompute against changing data: the run in flight
is computing a stale answer, so cancel it and start the current one. The
scheduler cancels the prior run through the runner and records the old
occurrence as `superseded`.

```ts
const previewBuild = { overlap: "supersede", catchUp: "none", maxCatchUp: 0 }
```

Do not choose `supersede` for a flow whose partial work is not safe to abandon.
Cancellation reaches the run through the control plane, and what a half-finished
flow leaves behind is the flow's problem, not the trigger's.

## Question two: the host was down across three boundaries

Ask whether those boundaries are still worth anything now.

**Choose `none` when only the present matters.** The default. A schedule that
polls current state does not want three replays of a stale poll.

**Choose `one` when the work is idempotent and the latest is what matters.** The
trigger fires the most recent missed boundary and forgets the rest. This is the
right answer for most report and sync schedules.

**Choose `all` to enumerate missed occurrences, oldest first, subject to overlap.**
A launched occurrence holds the trigger until its run settles. While a run
remains active, `skip` drops later occurrences and `buffer-one` coalesces them to the
newest. Enumeration does not guarantee that every occurrence executes.

A search refresh can tolerate coalescing because each run rebuilds current
state. Set `maxCatchUp` to bound how many occurrences are enumerated:

```ts
const searchRefresh = { overlap: "buffer-one", catchUp: "all", maxCatchUp: 24 }
```

For every-boundary work such as per-hour billing, use a durable queue or a flow
that processes its own complete interval backlog from a durable cursor. No
overlap policy turns `all` into a lossless queue.

`maxCatchUp` defaults to 0, and 0 means no occurrence may be caught up at all.
That is consistent with the `none` default, and it is a trap under `one` or
`all`: a declaration that names a catch-up policy and leaves the bound at 0 owes
work it is not allowed to do, and fails with `catch_up_bound_exceeded` the first
time it misses a boundary. Whenever `catchUp` is not `none`, set `maxCatchUp` to
at least 1.

The ceiling is `Schedule.maxCatchUpLimit`, which is 1000, the same cap one
occurrence search returns.

## What a breached bound does

The scheduler logs a warning annotated with the trigger id and abandons the
backlog when catch-up exceeds its bound. It still dispatches the current
occurrence subject to overlap, on the first poll after a restart and on every
later poll.

Size `maxCatchUp` for the longest outage you are willing to enumerate. It is
not a limit on how many runs finish.

## The nine combinations

Every pair is legal. Under `all`:

- `supersede` with `all` fires each owed occurrence and cancels the one before
  it, so the practical effect is that the newest occurrence survives and the
  older ones are recorded as `superseded`.
- `skip` with `all` records every owed occurrence as `skipped` while a run is in
  flight, which advances the cursor without doing the work. That is the correct
  reading of "skip", but check that it is what you meant.
- `buffer-one` with `all` keeps only the newest pending occurrence while a run
  is in flight. Intermediate occurrences coalesce even below `maxCatchUp`.

## Next

- [Declare and register a trigger](/guides/declare-a-trigger/).
- [Test trigger code](/guides/testing/), where a test clock makes a policy choice
  observable in milliseconds.
