---
title: "Cut-over from mq.py"
description: "What replaces each script around VibeLang's mq.py when its merge queue moves to @smthrs/merge-queue, and what is still missing."
---

VibeLang lands changes with `mq.py` and seven satellite scripts on the
maintainers' Mac and on the build server `nyc-01` (the 2026-11-10 dogfood
audit, [#4577](https://github.com/smithersai/smithers/issues/4577)). The
cut-over runs `.smithers/flows/merge-queue/flow.ts` instead. This page lists
each satellite as **covered** by the queue, a **gap** the queue does not fill
yet, or **dropped** on purpose. The cut-over waits for the gaps and for Will's
approval of a shadow run beside `mq.py`.

```text
satellite                        status    replaced by
-------------------------------  --------  ------------------------------------------
mq-pusher.sh (v1, v2, v3)        gap       nothing: the bookmark is local
lanes/mq-resolver.py             covered   CommandFixer + MQ_FIX_COMMAND, maxAttempts
mq-carry/carry.py, mq-carry.py   covered   MQ_FINISH_COMMAND, then the fix loop
bin/mq-prs.py                    gap       nothing: no pull request or comment input
bin/mq-watchdog.sh               dropped   the host's supervisor + `smthrs runs resume`
land-main (Mac and nyc-01)       covered   JjRepository's forward-only bookmark move
prescreen.py, mq-priority.py     covered   `probe`; `priority` on enqueue
```

## Covered

**`mq-resolver.py`** launches a fix agent per rejected entry, at most 3
attempts. `CommandFixer` runs `MQ_FIX_COMMAND` with a brief and an answer file
for each change the queue blames, and `Config.maxAttempts` caps the attempts;
after the last one the change is unmergeable with the failing checks recorded.
A fixed change re-queues at the back of its priority. The resolver's cap of 12
live agents has no equivalent: `CommandFixer` runs one agent per blamed change
(`src/CommandFixer.ts`, `concurrency: "unbounded"`). A cap, if the shadow run
shows one is needed, belongs in `CommandFixer`, not in `MQ_FIX_COMMAND`.

**`carry.py` and `mq-carry.py`** resolve conflicts with an agent and re-queue.
`JjRepository` replays each change on the tip and runs `MQ_FINISH_COMMAND` as
`<head> <onto> <conflicted>`; the command may resolve the conflict and prints
the commit that stands for the change. A change that still fails goes to the
fix loop above. Nothing polls over ssh, so the carry's crash (`json.loads` on
an empty ssh reply) has no counterpart.

**`land-main`** holds an `flock` across fetch, validate, move bookmark and
push, so one lane cannot push another lane's unchecked commit. The queue is
the only writer of its bookmark: it moves the bookmark only from the tip a run
was tested on onto that run's tree (`jj bookmark set`, which only moves
forwards), a commit someone else put there becomes a `foreign` event, and
rewritten history fails the round with `TargetDiverged`. The push half of
`land-main` is the `mq-pusher.sh` gap.

**`prescreen.py`** tests each entry alone. The policy's `probe` decision tests a
ready change alone on the tip with any free run slot, so a failing change
reaches a fix agent before it reaches the front.

**`mq-priority.py`** reorders the queue. An entry's `priority` is set when it
is enqueued, and runs take changes by priority, then arrival. To move a live
entry, withdraw it and enqueue the same commit under a new id: the queue never
reuses an id.

## Gaps

**`mq-pusher.sh`** mirrors the server's ready and green refs to GitHub every
20 s. `JjRepository` moves a local bookmark and states that "publishing it to
a remote is the host's job" (`src/JjRepository.ts`); no source in the package
pushes. The replacement is a push step in the queue's `Target`, so a landing is
recorded only after the remote has it and a failed push is a failed push, not
the v2 pusher's "pushed". It also needs a decision on the second ref: the queue
has one target, and `green` has no meaning in it yet.

**`mq-prs.py`** turns a `Merge` comment on a pull request into a queue entry
and keeps one status comment. The queue's only input is
`$MQ_STATE/inbox.jsonl`, and no source in `src/` mentions a pull request or a
comment. The replacement reads comments into `enqueue` lines and writes each
ending from `$MQ_STATE/endings.jsonl` back to the pull request. It touches
GitHub, so it is built on the GitHub library from
[the library catalog](https://github.com/smithersai/smithers/blob/main/docs/libraries.md),
outside this package.

## Dropped

**`mq-watchdog.sh`** restarts the runner over ssh when `pgrep` misses it twice.
The queue does not supervise its own process. The host runs the lineage loop
from [the README](./README.md#running-it-for-a-repository) under its service
manager (launchd `KeepAlive` or systemd `Restart=always`), and a restarted
host continues with `smthrs runs resume <run id>` from the last recorded
round. A round that fails because a service is down is retried without end,
so an outage delays landings and loses nothing.
