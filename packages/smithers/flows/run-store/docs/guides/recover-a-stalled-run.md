---
title: "Take over a stalled run"
description: "Reclaim a run whose owner stopped: build liveness evidence at the instant you use it, steal the stale row, activate it, and recover a claim nobody ever activated."
sidebar:
  order: 5
---

A run stalls in two different places, and each has its own operation:

- A **running owner stopped heartbeating.** The row is `running`, its
  `heartbeat_at_ms` is older than `heartbeatStaleAfter`, and no other process
  can write to it. `steal` takes it.
- A **claim was never activated.** The row is still `pending` or `suspended`,
  its claim columns are held by a claimant that died between `claim` and
  `activate`, and `claim` reports `AlreadyClaimed` forever. `recoverClaim`
  releases it.

Both require two independent things: the SQL predicate that the row really is
stale, and matching `LivenessEvidence` about the process that left it that way.
Neither alone is enough.

## Build evidence at the instant you spend it

`evidence.checkedAtMs` must equal the `nowMs` of the call that consumes it,
exactly, so evidence cannot be probed once and replayed later. Build it from a
[`LivenessCheck`](../concepts/liveness-evidence.md) inside the same effect that
uses it:

```ts
import { Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"

const probeFrom = (
  check: Ownership.LivenessCheck,
  heartbeatAtMs: number | null
): Ownership.LivenessProbe =>
(expectedOwner, claimant, checkedAtMs) =>
  Effect.map(
    check(expectedOwner, { claimant, heartbeatAtMs, nowMs: checkedAtMs }),
    (alive) =>
      alive ? undefined : {
        expectedOwner,
        checkedAtMs,
        kind: Ownership.sameHostIncarnation(expectedOwner, claimant)
          ? "same-host-pid-dead" as const
          : "cross-host-unreachable-stale" as const
      }
  )
```

The `kind` has to match the host relation or the store refuses it: a pid probe
means nothing across hosts, and an unreachability judgment means nothing on the
owner's own machine. A Node host can explicitly choose
`HostLiveness.sameHostPidProbe`; `Ownership.leaseLiveness()` is the floor every
host can give. The Node runtime's default policy is described below.

## Steal a stale running row, then activate it

```ts
import { RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as Clock from "effect/Clock"

const takeOver = (runId: string, claimant: OwnerId, check: Ownership.LivenessCheck) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    if (row.status !== "running" || row.owner === null) return { _tag: "NotRunning" } as const

    const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const nowMs = yield* Clock.currentTimeMillis
    const evidence = yield* probeFrom(check, row.heartbeatAtMs)(row.owner, claimant, nowMs)
    if (evidence === undefined) return { _tag: "OwnerAlive" } as const

    const stolen = yield* runs.steal(runId, expected, claimant, nowMs, evidence)
    if (stolen._tag !== "Claimed") return stolen
    return yield* runs.activate(runId, claimant, stolen.claimedAtMs, expected)
  })
```

A successful steal writes the claim columns and nothing else, so the row's
status, owner, and heartbeat are still the ones you read. That is why the same
`expected` snapshot satisfies the activation, and why the takeover path and the
ordinary claim path converge on `activate`.

| Steal outcome         | What it means                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `Claimed`             | The claim columns are yours. `claimedAtMs` is your activation token.                      |
| `LivenessUnconfirmed` | The evidence did not match the owner, the host relation, or `nowMs`. No comparison ran.   |
| `HeartbeatFresh`      | The persisted heartbeat is still inside the staleness window. The owner is not stale yet. |
| `SnapshotChanged`     | The evidence matched, and the row moved between your read and your write.                 |
| `AlreadyClaimed`      | Another process already holds the claim columns.                                          |
| `NotFound`            | No such run row.                                                                          |

`LivenessUnconfirmed` and `SnapshotChanged` are deliberately separate: the first
says you were not allowed to try, the second says you tried and lost.

## Recover a claim nobody activated

`recoverClaim` clears an exact stale claim so the row becomes claimable again.
It takes the claimant it is displacing, that claimant's `claimedAtMs` as a fence
token, your own identity as the observer, and evidence about the dead claimant:

```ts
const releaseStaleClaim = (runId: string, observer: OwnerId, check: Ownership.LivenessCheck) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* runs.get(runId)
    if (row.claim === null || row.claimedAtMs === null) return { _tag: "NoClaim" } as const

    const nowMs = yield* Clock.currentTimeMillis
    const evidence = yield* probeFrom(check, row.heartbeatAtMs)(row.claim, observer, nowMs)
    if (evidence === undefined) return { _tag: "ClaimantAlive" } as const

    return yield* runs.recoverClaim(runId, row.claim, row.claimedAtMs, observer, nowMs, evidence)
  })
```

`Recovered` means the claim columns are clear. Claim the run normally after
that; recovery does not hand you the run, it only unblocks it.

| Recover outcome       | What it means                                                                      |
| --------------------- | ---------------------------------------------------------------------------------- |
| `Recovered`           | The stale claim is cleared. Any process may now claim the run.                     |
| `ClaimFresh`          | The claim is younger than `heartbeatStaleAfter`. Wait, or leave it alone.          |
| `ClaimChanged`        | The row no longer carries the claim you named, so someone else already handled it. |
| `LivenessUnconfirmed` | The evidence did not match the claimant, the host relation, or `nowMs`.            |
| `NotFound`            | No such run row.                                                                   |

An owner that loses its own activation does not need any of this:
`abandonClaim` releases a claim cooperatively, and it is what
[Claim a run and finish it](./claim-and-finish-a-run.md) does when an activation
loses. `recoverClaim` is for the claimant that will never come back.

## The two cutoffs are the same number

`steal` refuses any row whose `heartbeat_at_ms` is within `heartbeatStaleAfter`
of your `nowMs`, and `recoverClaim` refuses any claim whose `claimed_at_ms` is
within the same window. Both compare against the `nowMs` you passed, and both
refuse a `nowMs` that runs more than `heartbeatSkewAllowance` ahead of the
store's own clock with `invalid_run`, so no caller can shorten either window by
reporting a later time.

## Let the engine do it

If you are running the Smithers engine, this sweep already exists.
`NodeRuntime` comes from [`@smthrs/platform-node`](/api/platform-node).
Its `isAlive` option is optional and defaults to
`HostLiveness.isAlive({ hostId })`. It probes local pids, reclaims an earlier
nonce under the claimant's own pid after lease expiry, and treats foreign-host
owners as alive (`crossHostPolicy: "alive"`). Expired leases alone therefore
do not reclaim runs owned by a foreign host; provide a deployment-specific
check when those runs must be recovered.

The following example explicitly chooses `HostLiveness.sameHostPidProbe`
instead. It probes the claimant's own pid even when the nonce differs and
answers `false` for foreign hosts (`crossHostPolicy: "lease"`), leaving their
takeover to the expired lease:

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

Write the sweep yourself only for a host, an adapter, or an operator tool that
has to agree with the engine about who owns what.

## Next steps

- [Liveness evidence](../concepts/liveness-evidence.md): the three kinds, and
  why every unknown probe answer is read as life.
- [The heartbeat lease](../concepts/leases.md): what the staleness window can
  and cannot promise.
- [Observe store outcomes](./observe-outcomes.md): the counters that make a
  takeover visible without reading logs.
