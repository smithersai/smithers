---
title: "Ownership and fencing"
description: "How one engine claims a run, how every durable write is fenced on an OwnerId, and how a run is reclaimed from an owner that stopped heartbeating."
sidebar:
  order: 1
---

Two processes can open the same database. Nothing in SQLite stops the second
one from driving a run the first one is already driving, and nothing in the
first one notices. Ownership is the answer: exactly one incarnation owns a run
at a time, every durable write it makes is conditioned on still being that
owner, and a run whose owner went away can be taken over on evidence rather
than on a guess.

## The OwnerId

An `OwnerId` is a triple: the `hostId` the composition declares, a `pid`, and a
fresh `nonce`. `OwnerIdentity` mints it, once per incarnation:

```ts
import { OwnerIdentity } from "@smthrs/engine-store"

const identity = OwnerIdentity.layer
```

The default reads a process id off `globalThis` where the platform has one, and
draws an incarnation number from `Random` where it does not, as in a browser
worker. The nonce is a UUIDv4 from the injected `Crypto` service.
`layerConstant(owner)` pins the whole token, which is what a test wants, and
what a host that already holds a lease from somewhere else wants.

The nonce is what makes the token an incarnation rather than a machine. A
process that restarts on the same host with the same pid mints a different
token, so its writes are correctly refused against runs the previous
incarnation still owns.

## What fencing means in practice

The engine claims a run before driving it, and from then on every durable write
carries the owner:

- Run state transitions go through the run store, which asks the journal's
  consensus strategy whether the owner still holds the run inside the same
  write transaction. A stale owner gets `FenceLost`.
- Attempt lifecycle writes pass the owner to the journal, which fences the
  append. A reclaimed owner fails with `fence_lost` and self-interrupts rather
  than appending.
- `DurableEngineState.park` and `scheduleClock` take the owner, so a process
  that no longer runs a run cannot park it or arm a timer against it.
- Terminal transitions additionally assert `{ cancelRequested: "absent" }`
  inside the same compare-and-swap, so a cancellation that arrives after the
  last poll turns finalize into a cancellation rather than a `completed` write.
- An action body's own writes carry the fence too. The engine supplies the
  running attempt's fence as `Action.CurrentFence`, and the body adds
  `RunStore.owned` for it to its own `UPDATE`. After a takeover, or once the
  attempt settled, the statement changes no row. On PostgreSQL the condition
  reads the run and attempt rows `FOR SHARE`, so a concurrent takeover waits
  for the body's write to commit instead of overtaking it.

The consequence is that a zombie process is harmless. It can hold a live fiber
and a live database handle, and every write it attempts against a reclaimed run
is refused by the row it is writing to.

A dispatch fences the run before it runs a step or writes anything a step
changes. A dispatch that a recorded attempt answers on its own does neither, so
it sends no heartbeat (see [Attempts and replay](./attempts-and-replay.md)). A
zombie therefore still replays what its run recorded, and is stopped at its
first step that runs.

## The lease, and the evidence to break it

An owner heartbeats while it drives. `isAlive` on `EngineStore.Options` decides
whether a run whose lease has expired may be stolen; answering `true` refuses
the takeover.

The default is `Ownership.leaseLiveness(Ownership.heartbeatStaleAfter)`: the
owner counts as alive while its persisted `heartbeat_at_ms` is younger than the
staleness cutoff, and gone once it is not. That is the weakest honest answer,
and the only evidence every host has. It is also enough: a process killed with
SIGKILL stops heartbeating, so a fresh process reclaims its runs with no
application code at all.

A deployment that knows more supplies its own check and refuses the takeover
for longer. A `process.kill(pid, 0)` probe is one such check;
`HostLiveness.sameHostPidProbe` is the shipped version. Guard any pid read with
`Ownership.sameHostIncarnation`, because a pid names a process only inside its
own host's namespace. A supplied check receives the recorded owner and a
`LivenessContext` of `{ claimant, heartbeatAtMs, nowMs }`.

A supplied check also takes a run sooner. While the lease is still fresh, the
store asks it about an owner on this host whose pid is not this process's
own. Answering `false` there means the process is gone, and the run is taken at
once with `same-host-pid-dead` evidence instead of waiting out the lease. That
is what lets a rerun after `kill -9` resume immediately. An owner on another
host, an owner with this process's pid, or a check that answers `true` keeps
the wait, and a pid the system reused for a live process answers `true`.

## The journal says which answer was used

Every arbitration is recorded, so a takeover is auditable after the fact:

| Record                                                                 | Meaning                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `steal-refused-owner-alive` with `evidence: "lease-fresh"`             | The lease was still inside the staleness window, and no same-host probe proved the owner gone. |
| `steal-refused-owner-alive` with `evidence: "probe"`                   | The supplied `isAlive` check answered for the owner.                                           |
| `stolen-and-activated` with `evidence: "lease-expired"`                | The lease had expired and no check refused it.                                                 |
| `stolen-and-activated` with `evidence: "same-host-pid-dead"`           | A same-host probe found the process gone, inside the window or after it.                       |
| `stolen-and-activated` with `evidence: "cross-host-unreachable-stale"` | The owner was on another host and unreachable past the window.                                 |

A refusal is journaled once, not once per sweep tick. The record is addressed
by the run, the refused owner, the lease it was refused against, and the
evidence that refused it, and it carries source sequence 0, so the journal's
first-writer admission collapses every repeat about an unchanged lease into one
record. The evidence is part of the address because one lease can be refused
twice for different reasons: a wake arriving while the owner is still pulsing
is refused by the lease, and the same owner, alive but stalled past the window,
is refused by the probe. Both records stand.

## A host that wakes one execution

An engine composed with `sweep: { host: executionId }`, such as one built inside
a Cloudflare Durable Object alarm, renews no lease: the alarm's host runs one
incarnation at a time, and that, not a heartbeat, is the liveness evidence.
Each incarnation draws its incarnation number with
`OwnerIdentity.layerWithoutPid`, and the host's `isAlive` answers `false` for
an earlier incarnation of the same host. The next incarnation therefore steals
a crashed one's run at once with `same-host-pid-dead` evidence, adopts the
attempt it left running, and runs it again under a new fence. Writes the
crashed incarnation still makes are refused by the rows they target.

Because nothing renews the lease, a process engine sharing the store would
reclaim the run once the lease went stale. Route hosted executions away from
every other engine with `canExecute`.

## Backoff, so arbitration keeps moving

The driver stops re-probing a run it was just refused. Each refusal defers that
run for two heartbeat ticks, doubling per consecutive refusal against the same
lease up to `heartbeatStaleAfter`. The stale-running sweep reads past exactly
the rows it is going to skip, so its batch of 64 keeps advancing. Without that,
the oldest stale rows sort first every second and a run behind them is never
arbitrated at all.

A deferral is forgotten as soon as its row leaves the stale window: the owner
resumed heartbeating, the run was stolen, or the run settled. A fresh stall
under a new lease is therefore probed on the first tick that sees it, rather
than waiting out a backoff it did not earn.

## Restoring a backup resets the fence

A restored database still carries the owner tokens that were live when the
backup was taken. `DisasterRecovery.fence` clears every pending claim and
suspends every run that was `running`, in one serialized write transaction, so
a surviving pre-backup owner fails its compare-and-swap immediately and the
restored runs are claimable without waiting out the staleness cutoff. See
[Back up and restore the store](../guides/back-up-and-restore.md).

## Related

- [Reclaim runs from a dead host](../guides/reclaim-runs-from-a-dead-host.md):
  the task-shaped version of this page.
- [Attempts and replay](./attempts-and-replay.md): what a reclaiming process
  does with the attempt rows the previous owner left behind.
