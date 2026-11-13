---
title: "Liveness evidence"
description: "The three kinds of evidence that admit a takeover, why evidence binds to one instant, the difference between a LivenessCheck and a LivenessProbe, and why every probe failure is read as life."
sidebar:
  order: 3
---

An expired lease says the owner stopped writing. It does not say the owner
stopped working. Evidence is the second lever: a claim about the recorded owner
that the store can check before it admits a takeover.

## Three kinds, three scopes

`Ownership.LivenessEvidence` carries the owner it is about, the instant it was
observed, and what kind of claim it is:

```ts
import type { LivenessEvidence } from "@smthrs/run-store/Ownership"

const evidence: LivenessEvidence = {
  expectedOwner: { hostId: "host-a", pid: 4102, nonce: "3f9c" },
  checkedAtMs: 1757000030000,
  kind: "same-host-pid-dead"
}
```

Each kind is admitted only where it means something:

- **`same-host-pid-dead`** is a local process probe. A pid names a process only
  inside one process namespace, so the store accepts this kind only when the
  observer and the recorded owner share a `hostId`.
- **`cross-host-unreachable-stale`** is a reachability judgment the deployment
  makes. It is accepted only when the hosts differ: on the owner's own host it
  would be an unprobed guess dressed as evidence.
- **`lease-expired`** asserts only that the persisted heartbeat is older than
  the staleness cutoff. That is the one claim the store can verify for itself,
  and `steal` does verify it: the write refuses any row whose `heartbeat_at_ms`
  is still inside the window. It is therefore accepted from any host.

Two of the three are collected outside this package, because the store never
probes a process or a network itself. It validates what it is handed.

## Evidence binds to one instant

`evidence.checkedAtMs` must equal the `nowMs` of the call that consumes it,
exactly. A probe taken at T is refused by a call made at T plus one
millisecond, and the caller has to build fresh evidence.

That rule is what stops a probe from being replayed. Without it, a caller could
hold one "the owner is dead" observation and spend it against a run whose owner
came back. `claimAndOwn`, `recoverClaim`, and `steal` all enforce it.

`steal` also separates two refusals that look alike from outside.
`LivenessUnconfirmed` means the evidence did not match the snapshot's owner,
the host relation its `kind` requires, or `nowMs`, so no compare-and-swap ran
at all. `SnapshotChanged` is reserved for matching evidence whose comparison
lost to a row that moved. A caller can tell "I was not allowed to try" from "I
tried and lost".

## A check answers, a probe produces

Two types sit either side of the store, and they answer different questions.

**`LivenessCheck`** is the question the arbitration asks before it decides to
steal: is the recorded owner still working? It takes the owner and a
`LivenessContext` carrying the claimant, the persisted `heartbeatAtMs`, and the
`nowMs` the decision is made against, and answers a boolean. Answering `true`
refuses the takeover. The engine consults it only for a run whose lease has
already expired.

**`LivenessProbe`** is the evidence factory: given the expected owner, the
claimant, and the instant, it produces `LivenessEvidence` or `undefined` for
`steal`, `claimAndOwn`, and `recoverClaim` to verify.

The portable package ships lease and single-incarnation checks; Node PID
checks live in `@smthrs/platform-node`.

`Ownership.leaseLiveness(staleAfter?)` is the portable engine's default and the
honest floor: an owner is alive for as long as its persisted heartbeat is
younger than the cutoff, and gone once it is not. It is the weakest answer, and the one every
host can give. A fresh process with no application code at all can reclaim a
hard-killed owner's runs once the lease it stopped renewing expires.

`NodeRuntime` from [`@smthrs/platform-node`](/api/platform-node) supplies a
different default. Its `isAlive` option is optional: without it, the runtime uses
`HostLiveness.isAlive({ hostId })` for the configured host. This checks local
pids and treats foreign-host owners as alive (`crossHostPolicy: "alive"`).
An expired lease alone never reclaims a foreign-host owner's run with this
default; supply a deployment-specific check to establish that owner's death.
For the claimant's own pid with an earlier nonce, the default answers dead,
allowing recovery of a previous incarnation after its lease expires.

`HostLiveness.sameHostPidProbe` is an explicit alternative. It probes even
the claimant's own pid, and answers `false` for a foreign host
(`crossHostPolicy: "lease"`), leaving takeover to the expired lease. This
example opts into that policy:

```ts
import { HostLiveness, type NodeRuntime } from "@smthrs/platform-node"
import { Ownership } from "@smthrs/run-store"

const options: NodeRuntime.Options = {
  filename: ".smithers/smithers.db",
  workspaceRoot: "/srv/workspace",
  owner: { hostId: "host-a" },
  isAlive: HostLiveness.sameHostPidProbe
}
```

It exists because the lease alone is only a timeout: two engine processes over
one database steal each other's running rows `heartbeatStaleAfter` after any
heartbeat stall, whether that stall was a dead process, a stop-the-world pause,
or a disk that blocked too long. The probe answers the question the lease is
standing in for.

## Every unknown answer is life

`sameHostPidProbe` sends no signal. `process.kill(pid, 0)` performs only the
delivery checks, and exactly three answers matter:

- It returns: the process exists. The owner is alive.
- It throws `ESRCH`: no such process. This is the sole death answer.
- It throws anything else, including `EPERM` and `EINVAL`, or the pid is not a
  positive safe integer: the owner is treated as alive, because an unknown
  answer is not death.

Unknown local probe results preserve liveness. A custom check must justify
answering `false`: after lease expiry, that answer admits a takeover.

Two limits of `sameHostPidProbe` bound what reclaim can promise:

- **An owner recorded with the claimant's own pid is always alive.** A previous
  incarnation of this process, or a second engine composed inside it, differs
  from the claimant only by `nonce`, and the process it names is this one. Such
  a row is never stolen while the process lives, so an embedded host that
  re-creates its engine in place should keep `leaseLiveness`, whose timeout does
  expire.
- **A reused pid reports the unrelated process that now holds it.** The dead
  owner's row stays refused for as long as that process lives, which delays
  reclaim rather than breaking it: the row is still `running` under an expired
  lease, and the next probe after the pid is free reclaims it.

With `sameHostPidProbe`, a recorded owner on another host is never probed.
The answer is `false`, which adds no evidence and lets the expired lease
decide, so a host that dies for
good does not strand its runs where no other machine could ever produce
evidence about its pids.

## One incarnation per host

`Ownership.singleIncarnationLiveness` is for a host that runs one incarnation
per host id, so it needs no process table. A Cloudflare Durable Object builds
its engine only inside its alarm, and a browser engine only in the worker that
holds its origin's Web Lock. An owner recorded under the claimant's host id
with another `pid` or `nonce` is an earlier incarnation whose claim has ended,
so the check answers `false` while its lease is still fresh, and the new
incarnation takes the run at once. Every other owner, the claimant included,
is judged by `leaseLiveness()`.

`@smthrs/platform-cloudflare`'s `CloudflareRuntime` and
`@smthrs/platform-browser`'s `BrowserRuntime` pass it to the engine. A Node
host must not: two Node engines over one database can share a host id while
both are alive, and this check would let each steal the other's runs.

For the sequence a takeover actually runs, see
[Take over a stalled run](../guides/recover-a-stalled-run.md).
