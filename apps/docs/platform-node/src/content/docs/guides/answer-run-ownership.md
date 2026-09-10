---
title: "Answer whether a run owner is alive"
description: "Wire HostLiveness.isAlive as the probe the engine consults before it steals a run, understand why the rule errs toward alive, and know where the sibling implementation disagrees."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-node/docs/guides/answer-run-ownership.md"
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

`isAlive` returns a function from an owner to `Effect<boolean>`. The owner type
is structural: `{ hostId: string, pid: number }`, which is exactly the shape of
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/)'s `OwnerId` minus its nonce, so an `OwnerId`
is accepted without this package depending on the journal to name a type.

`@smthrs/flows`' `NodeRuntime` defaults to this function, so a program that
composes the runtime gets it without asking.

## The rule

The rule is asymmetric on purpose:

- **An owner on a different host is alive.** A pid means nothing across
  machines, and the process table this probe reads is only this machine's.
- **An owner on this host is dead only when the signal-0 probe reports
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

## Know where the sibling disagrees

`@smthrs/run-store`'s `Ownership.sameHostPidProbe` fills the same
`LivenessCheck`. Both probes use the same `ESRCH`-only death rule.
`EPERM`, `EINVAL`, and unknown signal errors preserve liveness.

The signal-error rows describe valid same-host pids:

| Input                                         | `HostLiveness.isAlive` | `Ownership.sameHostPidProbe` |
| --------------------------------------------- | --------------------- | --------------------------- |
| signal error `ESRCH`                           | dead                  | dead                        |
| signal error `EPERM`, `EINVAL`, or unknown error | alive                 | alive                       |
| owner on a different `hostId`                  | alive                 | defer to expired lease      |

`sameHostPidProbe` returns `false` for a foreign host without probing its pid.
The engine consults it after lease expiry, and the store verifies the expired
lease before allowing a steal. `HostLiveness.isAlive` returns `true` for a
foreign host, so runs on a permanently dead host wait for an operator.

Which answer a deployment gets depends on the entry point it used:
`@smthrs/flows`' `NodeRuntime` defaults to this function, while
[`@smthrs/cli`](https://cli.smithers.sh/reference/api/)'s `NodeControl` passes `sameHostPidProbe`.

`HostLiveness.isAlive` compares with its configured `hostId` and ignores the
`context` argument of `Ownership.LivenessCheck`. `sameHostPidProbe` compares
with `context.claimant.hostId`. Pick the probe for its cross-host policy and
source of host identity.
