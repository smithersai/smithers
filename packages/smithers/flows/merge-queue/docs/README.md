---
title: "@smthrs/merge-queue"
description: "A merge queue proved in Lean: the target branch moves only onto a tree whose every required check passed, with streaming results, fix agents, bisection, unmergeable-with-a-reason and predicted durations."
---

`@smthrs/merge-queue` is a merge queue you can trust with a branch. Its rules
are written twice: as an executable Lean 4 model with a proof of every
invariant, and as this TypeScript package, which has the same states,
transitions and names. A differential test runs random event traces through
both and fails on the first difference.

## What it guarantees

Each line is a theorem of the reference; [the matrix](../lean/INVARIANTS.md)
names it.

- **The target is always green.** The target's tree is the tree it started
  from, or exactly the tree of a recorded landing whose result was complete
  and green.
- **The tested tree is the merged tree.** Only a landing moves the target, and
  it moves it onto the tree one run tested, never a tree rebuilt afterwards.
- **A partial result never merges.** Results stream in one check at a time; a
  run that still misses a required check cannot land, whatever has passed.
- **Fixing starts at the first failure.** One failed check is enough to send a
  lone failing change to a fix agent; the run's later failures keep reaching
  that agent.
- **Nothing is lost or merged twice.** Every change the queue has seen ends
  merged, unmergeable with a reason, or withdrawn, and stays that way.
- **Fix loops end.** A change uses at most `maxAttempts` fix attempts. After
  that it is unmergeable, with the failing checks recorded.
- **Unmergeable always has a reason.** A fix agent's verdict stands only with
  written words for the author.
- **Order is kept.** A run always tests the first ready changes by priority,
  then arrival. A fixed change keeps its place.
- **A crash loses nothing.** Losing any runs at any moment keeps every
  invariant, delivering any event twice is the same as delivering it once, and
  the next decision is a function of the durable state alone.
- **Predictions never decide.** Durations order the checks and give an ETA.
  They never drop a check and never change what lands.

## How it works

```text
          enqueue            start               result (streams)
author ───────────▶ queued ───────▶ run on tree ◀──────────────── CI
                      ▲                 │
            fixed     │      ┌──────────┼─────────────┐
         (new rev)    │      │ green,   │ failed,     │ failed,
                      │      │ complete │ one suspect │ several suspects
                   fixing ◀──┼──────────┘             │
                      │      ▼                        ▼
             gaveUp   │    land: target = that tree   bisect: test a
                      ▼                               shorter prefix
                 unmergeable (with a reason)
```

A **tree** is the list of change revisions applied to the target, in order.
The target branch is a tree; a candidate is the target's tree plus the first
ready changes. Two trees are the same exactly when they apply the same
revisions in the same order, so "the tree that was tested" is a precise thing.

The queue is one function, `step(config, state, event)`. Every state change is
an event, and every event has a guard: an event whose guard fails returns the
state unchanged. Five events arrive from outside (`enqueue`, `withdraw`,
`result`, `fixed`, `gaveUp`). Four are the queue's own decisions (`start`,
`land`, `blame`, `cancel`), and `plan(config, state)` picks the next one:

1. **Land** the longest run that is live, complete and green.
2. **Blame** the one change left in a failed run. It goes to a fix agent, or,
   with no attempts left, out of the queue with a reason.
3. **Cancel** a run that can no longer land or help a fix.
4. **Start** the next run. With no known failure it extends the longest prefix
   under test by up to `maxBatch` changes, so later batches are tested
   speculatively on top of earlier ones. With the first `m` changes known to
   fail together it tests a prefix halfway to `m`: bisection.

Safety does not depend on `plan`. `step` checks every guard itself, so a wrong
policy can waste CI time and cannot land an untested tree.

## When a change is unmergeable

Two things put a change out of the queue, and both record why:

- **`attemptsExhausted`**: the change failed as the only suspect with no fix
  attempt left. The reason holds the failed checks and the attempts used.
- **`agentVerdict`**: a fix agent, after seeing the failures and the changes
  ahead, judged that the change must be redone from scratch (for example an
  old change whose rebase conflicts with most of what it touches). The verdict
  is refused without written words, and the reason holds those words, the
  failed checks the agent worked from and the attempts used.

This should be rare: a change gets `maxAttempts` real fixes first unless an
agent states in writing why fixing is pointless.

## Predicted durations

The queue remembers the last `window` durations of each check. `estimate` is
their median, `schedule` orders the required checks slowest first, and `eta`
is the slowest check a run still waits for. `renderState` shows each run's ETA
and remaining checks.

## The reference

`lean/` is a Lake project (Lean 4, core only). `lake build` proves every
theorem, with warnings as errors, so a `sorry` cannot pass. `lake build
reference` builds a binary that reads an event trace on stdin and prints the
state after each line; `src/Trace.ts` prints the same lines.

```sh
cd lean && lake build reference
pnpm differential            # random traces through both; any difference fails
pnpm reference               # regenerate test/fixtures from the reference
```

The unit suite needs no Lean: `test/fixtures/reference.json` holds a digest of
what the reference printed for 400 random traces, and the suite replays the
same traces through the kernel.
