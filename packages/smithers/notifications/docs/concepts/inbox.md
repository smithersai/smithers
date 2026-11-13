---
title: "Who hears about a run"
description: "How Inbox routes a run's state to its launcher and its watchers, when a changed notice shows again, and why acks from several devices never conflict."
sidebar:
  order: 4
---

The queue tells a running agent something. `Inbox` covers the other direction:
which people hear about a run, and what their notice says. A notice is one
person's durable record about one run. Toasts, lists and browser notifications
are views of it.

`Inbox` is pure. It decides who gets a notice and how a notice changes; the
host stores the rows, in the same transaction as the journal fact that caused
them.

## A watch has a level

A principal follows a subject through a watch. The subject can be a run, a
flow, a branch or a repository, and the watch's level is one of three:

| Level       | What the principal hears about another person's run   |
| ----------- | ----------------------------------------------------- |
| `all`       | Every state, and each notice enters their list.       |
| `attention` | Every state as a toast while it lives; no list entry. |
| `muted`     | Nothing.                                              |

`Inbox.DEFAULT_LEVEL` is `attention`.

## The launcher's notice

`Inbox.route` takes one run fact: its launcher, its state and every watch that
covers it. It answers with one delivery per recipient:

```ts
import { Inbox } from "@smthrs/notifications"

Inbox.route({
  launcher: "ana",
  state: "needs_you",
  watchers: [
    { principal: "ana", level: "muted" },
    { principal: "ben", level: "attention" },
    { principal: "cy", level: "all" }
  ]
})
```

```text
[
  { recipient: "ana", mine: true,  state: "needs_you", quiet: false },
  { recipient: "ben", mine: false, state: "waiting",   quiet: true },
  { recipient: "cy",  mine: false, state: "waiting",   quiet: false }
]
```

- The launcher comes first when it may read the run, with the run's own state.
  A muted watch never silences your own run.
- A run's question belongs to its launcher, so every watcher reads `needs_you`
  as `waiting`.
- An `attention` watcher's delivery is `quiet`. An `all` watcher's is not.
- `mayRead` removes anyone who may not read the run's repository, the launcher
  included.

A run on a branch reaches the people on that branch, and an event on a
repository reaches everyone watching the repository, because each is a watch on
that scope. `Inbox.audience` answers the second case for an event that is not a
run, such as `main` moving or a new release: the principals who hear it, in
input order.

### One principal, several watches

A principal can watch a run's branch and its repository at different levels.
Both functions keep only a principal's first entry, so list the most specific
watch first. A branch watch at `muted` before a repository watch at `all`
silences that branch's runs for that person.

## A version per notice

Every notice carries a `version`, and each act records the version it saw:

| Field              | Set by    | The notice is...                                 |
| ------------------ | --------- | ------------------------------------------------ |
| `readVersion`      | `read`    | unread while it is below `version` (`isUnread`). |
| `dismissedVersion` | `dismiss` | open while it is below `version` (`isOpen`).     |
| `hiddenVersion`    | `hide`    | hidden once it reaches `version` (`isHidden`).   |

When a notice needs attention again, its `version` goes up, and every earlier
act stops counting: the notice is open, unread and shown again on every device.
`Inbox.raises(before, after)` says when that happens. A new notice raises. A
change into `needs_you`, `failed` or `done` raises. Moving between `working`
and `waiting`, from `needs_you` back to `working`, or to the same state again
does not.

## Acks merge without conflicts

`Inbox.ack(notice, act, version)` sets the act's field to
`max(current, min(version, notice.version))`, the same merge as Postgres'
`greatest()`:

```ts
const notice = { version: 3, readVersion: 0, dismissedVersion: 0, hiddenVersion: 0 }

Inbox.ack(notice, "dismiss", 2) // dismissedVersion 2: version 3 stays open
Inbox.ack(notice, "dismiss", 9) // dismissedVersion 3: never past the notice's version
```

A field never goes back, so a phone that dismissed version 2 offline cannot
close version 3 when it reconnects. Two devices that ack the same notice reach
the same row in either order, and an ack delivered twice changes nothing. That
is why acks need no locking or conflict resolution: the host writes each one as
a `greatest()` update.

See the [API reference](../api.md#inbox) for every signature.
