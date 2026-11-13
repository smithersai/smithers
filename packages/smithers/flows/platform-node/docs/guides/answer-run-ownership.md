---
title: "Answer whether a run owner is alive"
description: "Wire HostLiveness.isAlive as the probe the engine consults before it steals a run, understand why the rule errs toward alive, and choose explicit cross-host and same-pid policies."
---

A durable run records the owner that holds it: a `hostId` and a pid. When
another process wants that run, it asks whether the recorded owner is still
alive. `HostLiveness.isAlive` is this package's answer.

Both ways of being wrong are expensive, and they are not equally expensive. A
wrong `true` strands a run until an operator intervenes. A wrong `false` runs
one run twice.

## Wire the probe

```ts
import { HostLiveness } from "@smthrs/platform-node"

const isAlive = HostLiveness.isAlive({ hostId: "engine-1" })
```

`isAlive` returns a function from an owner and an optional claim context to
`Effect<boolean>`. The owner type is structural:
`{ hostId: string, pid: number, nonce?: string }`, so
[`@smthrs/journal`](/api/journal)'s `OwnerId` is accepted without this package
depending on the journal to name a type. The context is
`{ claimant: Owner }`, the identity that would take the run over, so an
`Ownership.LivenessContext` is accepted too.

This package's `NodeRuntime` defaults to this function, so a program that
composes the runtime gets it without asking.

## The rule

The rule is asymmetric on purpose:

- **An owner on a different host is alive.** A pid means nothing across
  machines, and the process table this probe reads is only this machine's.
- **An owner with the claimant's own host and pid and another nonce is dead.**
  The engine asks only after that owner's lease expired, and the pid names the
  claimant itself. A host restarted under the same pid, as a container entry
  point is on every start, reclaims its crashed predecessor's runs.
- **Any other owner on this host is dead only when the signal-0 probe reports
  `ESRCH`.** Every other result preserves liveness.

`process.kill(pid, 0)` sends no signal. `EPERM` means
the process exists and belongs to another user, which is still a live owner
this host must not rob. A throw that is not an object at all carries no code,
and reading through it rather than off it is what keeps that from crashing the
probe: a thrown string or `null` is an answer nobody gave, which counts as a
live owner.

## The residual risk

Pid reuse. An owner whose pid was recycled by an unrelated program reads as
alive, and its run waits for an operator.

That is the safe direction. Nothing about a recycled pid can tell this process
whether the run is still being driven, and the cost of guessing wrong the other
way is two hosts executing one run.

## Substitute a better answer where you have one

A multi-process deployment with a supervisor or a lease system knows better
than any pid probe, and should answer from that instead. `isAlive` is one
implementation of a slot, not a fixed policy.

## Choose the policy

Both entry points use one signal-0 implementation.
Both probes use the same `ESRCH`-only death rule.
`EPERM`, `EINVAL`, and unknown signal errors preserve liveness. `isAlive` accepts
`crossHostPolicy: "alive" | "lease"` and `samePidPolicy: "reclaim" | "probe"`.
The defaults preserve foreign owners and reclaim an earlier nonce under the
claimant's own pid. Invalid pids are never signalled and count as alive.

`HostLiveness.sameHostPidProbe` selects `crossHostPolicy: "lease"` and
`samePidPolicy: "probe"`, taking the local host id from `context.claimant`.
It replaces the former `Ownership.sameHostPidProbe` export from
`@smthrs/run-store`:

```ts
import { HostLiveness } from "@smthrs/platform-node"

const isAlive = HostLiveness.sameHostPidProbe
```

| Input                                            | Default `isAlive({ hostId })` | `sameHostPidProbe`     |
| ------------------------------------------------ | ----------------------------- | ---------------------- |
| signal error `ESRCH`                             | dead                          | dead                   |
| signal error `EPERM`, `EINVAL`, or unknown error | alive                         | alive                  |
| owner on a different `hostId`                    | alive                         | defer to expired lease |
| claimant's own pid, another nonce                | dead                          | probe the pid          |

The engine consults liveness after lease expiry, and the store verifies the
expired lease before allowing a steal. `NodeRuntime` defaults to `isAlive`,
while the CLI selects `sameHostPidProbe`. Choose the policy and source of host
identity that match the deployment.
