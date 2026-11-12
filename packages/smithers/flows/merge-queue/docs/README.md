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
- **The tested tree is the merged tree.** The queue lands only the run it
  pushed, onto the tree that run tested, never a tree rebuilt afterwards.
- **Everything is rebased on the tip of the target.** A run is built on the
  target's tip, a landing is a fast-forward of that tip, and there is no side
  branch. When someone else moves the target, nothing tested on the old tip
  lands: the stack is rebuilt on the new tip and tested again.
- **The queue never blocks.** A new change is accepted in every state, a green
  run lands whatever else is failing or being fixed, and a moved target does
  not stop it.
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
  then arrival. A fixed change re-queues at the back of its priority, so it
  never jumps ahead of runs already in flight.
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
state unchanged. Seven events arrive from outside (`enqueue`, `withdraw`,
`result`, `fixed`, `gaveUp`, `foreign` for a commit someone else put on the
target, and `land` when the target is seen on the tree the queue pushed). Five
are the queue's own decisions (`start`, `probe`, `push`, `blame`, `cancel`), and
`plan(config, state)` picks the next one:

1. **Push** the longest run that is live, complete and green: fast-forward the
   target onto its tree. The landing is recorded when the target is seen
   there, so a push that loses a race lands nothing.
2. **Blame** the one change left in a failed run. It goes to a fix agent, or,
   with no attempts left, out of the queue with a reason.
3. **Cancel** a run that can no longer land or help a fix.
4. **Start** the next run. With no known failure it extends the longest prefix
   under test by up to `maxBatch` changes, so later batches are tested
   speculatively on top of earlier ones. With the first `m` changes known to
   fail together it tests prefixes between the longest unfailed one and `m`,
   one split point per free run slot: bisection, in parallel.
5. **Probe** a ready change alone on the tip, with any run slot left. A probe
   finds a failing change before it reaches the front of the queue, so it goes
   to a fix agent without holding up the changes around it. Probes are why
   throughput does not collapse when changes fail.

Safety does not depend on `plan`. `step` checks every guard itself, so a wrong
policy can waste CI time and cannot land an untested tree.

## The driver

`Driver.round(config, position)` is one round of the queue against the world,
through five services a host provides: `Inbox` (changes handed in and taken
back), `Ci`, `Fixer` (fix agents), `Target` (the branch) and `Endings` (the
record of how each change ended).

```text
record   write the changes the round before ended into the record of endings
sync     make the world match the state: have the target settle the parts
         the queue cut from its trees, fast-forward the target onto the
         tree being pushed (compare-and-swap from the tip it was tested on),
         keep exactly the wanted CI runs and fix agents going
gather   read the target's tip, new letters, every finished check, lost
         runs, fix agents' answers; wait only when there is nothing new and
         nothing to decide
fold     apply those events and let the policy settle, dropping each change
         as it ends
check    the state's tree must be exactly the tip that was read
cut      drop from the state's trees the parts every run was built on
```

The state a round returns is pruned: after every event the driver drops the
changes that ended and the landings, so a host carries only what is still in
the queue, however long the queue has run. Nothing the queue decides reads an
ended change or a landing, and the Lean reference proves that the pruned queue
decides exactly what a queue that keeps everything decides (`pruned_plan`,
`pruned_step`, `pruned_round`). One rule makes that true: **a change id is
never used again.** The queue no longer holds an ended change, so it cannot
refuse its id; the file inbox does, by passing over an `enqueue` line whose id
an earlier line enqueued.

The target's tree only grows, so the round also cuts it. The parts every run
the queue holds was built on are behind the queue for good; the round drops
them from the target's tree and from every run's base (`settled`, `cut`) and
adds their number to `Position.settled`. The next round begins by telling the
target that count (`Target.settle`), and the target then speaks of trees from
there too. For a jj repository that moves the ledger's starting commit forward
and drops the ledger entries only the settled parts needed. A CI job carries
the count its tree was named at (`Job.from`), so a candidate still being built
when the start moves is the same commit afterwards. The reference proves that
the cut queue decides what the full queue decides (`cut_plan`, `cut_step`,
`kept_round`) and that what the driver cuts is always a shared prefix
(`settled_onPrefix`). With both prunings, what a host records each round is a
few kilobytes however many changes have gone through.

A round returns the changes it ended (`Outcome.ended`), and the next round
records them. The record therefore holds only a decision the host kept: a
round that runs twice after a crash may decide differently the second time,
and only the outcome that became the next position is written. The queue is
not `done` until the last endings are recorded.

Every command is derived from the state alone and is a reconciliation, so a
host records the position between rounds and repeats a round after a crash.
The tip is read every round, never assumed. A commit on top of it that the
queue did not put there becomes a `foreign` event. A tip that does not extend
the tree the queue knows (rewritten history) fails the round with
`TargetDiverged` and changes nothing.

## The durable flow

`QueueFlow.Queue` is the queue as an `@smthrs/flow` flow. One flow round is
one driver round: a single recorded action (`QueueFlow.Round`) whose result,
the queue's next position, is the payload of the next round. The queue's
whole state lives in the flow's journal, so a host that dies resumes at the
last recorded position on another engine over the same store. A round that
fails because a service is down is retried from 200 ms up to every 30 s,
without end: an outage delays landings and loses nothing. The flow has no
pause or hold; it ends only when the inbox was closed and every change ended.

```ts
import { Action, Interpreter } from "@smthrs/flow"
import { empty, QueueFlow } from "@smthrs/merge-queue"

const layer = Layer.mergeAll(QueueFlow.layer, Interpreter.layer(QueueFlow.Queue)).pipe(
  Layer.provideMerge(services), // Inbox, Ci, Fixer, Target, Endings
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(engine)
)
QueueFlow.Queue.execute(
  { config, state: empty, cursor: 0, closed: false, ended: [], settled: 0, round: 0 },
  { executionId: "main" }
)
```

## Running it for a repository

`.smithers/flows/merge-queue/flow.ts` is the host: a file flow that provides
the five services from the environment and starts the queue.

```sh
export MQ_REPO=/srv/repo            # the jj repository
export MQ_STATE=/srv/queue          # inbox, ledger, fix briefs and the record of endings
export MQ_CHECK_COMMAND='...'       # sh -c "$MQ_CHECK_COMMAND" sh <check> <commit>; exit 0 passes
export MQ_RUN_COMMAND='...'         # instead: one process per run, sh -c "$MQ_RUN_COMMAND" sh <commit> <check>...
                                    # prints "<check> pass" or "<check> fail" as each check finishes
export MQ_FINISH_COMMAND='...'      # optional: sh -c "$MQ_FINISH_COMMAND" sh <head> <onto> <conflicted>
                                    # prints the commit that stands for the rebased change
export MQ_FIX_COMMAND='...'         # sh -c "$MQ_FIX_COMMAND" sh <brief file> <answer file>
smthrs flow start merge-queue --data @start.json
```

`start.json` is `{ "config": {...}, "state": <the empty state>, "cursor": 0,
"closed": false, "ended": [], "settled": 0, "round": 0 }`. Hand a change in by appending one line to
`$MQ_STATE/inbox.jsonl`:

```json
{ "_tag": "enqueue", "id": 42, "priority": 0, "commit": "<commit id>" }
```

`commit` is one commit id, or a jj revset of a stack of commits such as `"<first> | <second>"`. A stack is
rebased, tested and landed whole.

When generated files must be rebuilt after a rebase, set `MQ_FINISH_COMMAND`. It runs on each change after the
change is replayed on the tip (and on the changes before it), may resolve conflicts and add commits on top, and
prints the commit that now stands for the change. That commit is the one tested and the one that lands.

`{"_tag":"withdraw","id":42}` takes it back and `{"_tag":"close"}` lets the
run finish once every change has ended. After a host dies, `smthrs runs resume
<run id>` continues from the last recorded round.

## How each change ended

The host appends one line to `$MQ_STATE/endings.jsonl` for every change that
ended. The file is the record an author, a dashboard or an audit reads; it is
kept outside the queue's state, so it outlives whatever the queue forgets.

```json
{"id":42,"rev":1,"attempts":1,"status":{"_tag":"merged"},"landing":{"run":17,"results":[{"check":1,"verdict":"pass"}],"foreign":false},"at":1794480000000}
{"id":43,"rev":0,"attempts":2,"status":{"_tag":"unmergeable","reason":{"kind":"agentVerdict","detail":"written against the old parser; redo it","failures":[2],"attempts":2}},"landing":null,"at":1794480000000}
{"id":44,"rev":0,"attempts":0,"status":{"_tag":"withdrawn"},"landing":null,"at":1794480000000}
```

`rev` is the revision that ended and `attempts` the fix attempts it used. A
merged change carries the run that tested the tree it landed in and that
run's results. A commit someone else put on the target is recorded as merged
with `"foreign": true` and no results: the queue adopted it untested. `at` is
when the line was written, in milliseconds since the epoch. A change has one
line: `FileEndings.record` skips a change the file already holds, and a line
cut short by a crash is passed over and written again.

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
