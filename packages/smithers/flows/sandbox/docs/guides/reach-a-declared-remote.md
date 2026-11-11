---
title: "Reach a declared remote from a flow"
description: "Open a session on a machine the workspace's S.Remotes declares, from a module flow on the smthrs host, with Remotes and the remote:acquire capability."
---

A module flow started by `smthrs flow start` runs its actions' commands under
the host's process confinement: a private `HOME`, reads only inside the
workspace, no host credentials. That is right for the flow's own commands and
wrong for a transport such as `ssh`, which needs the operator's keys and
`/etc/passwd`. `Remotes` lets an action reach a machine anyway, on the
operator's terms: the operator declares the machine in `WORKSPACE.ts`, the flow
names it in its capabilities, and the host starts the transport itself.

## Declare the machine

`S.Remotes` in `.smithers/WORKSPACE.ts` is the declaration `smthrs ci --remote`
reads. A flow reaches the same entries by name:

```ts
remotes: S.Remotes({
  fuzz: S.Remote.Command({
    machines: [["ssh", "-o", "BatchMode=yes", "ci@build-host"]],
    workdir: "/var/tmp/fuzz-campaign"
  })
})
```

## Grant it to the flow

`remote:acquire:<name>` admits an action to one remote. The flow declares it
like any other capability, and the run's approval grants it:

```ts
export default Flow.make("fuzz-campaign", {
  description: "Run a fuzz campaign on the build host",
  capabilities: ["remote:acquire:fuzz"]
  // ...
})
```

## Acquire a session

```ts
import { Remotes } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

export const layer = Campaign.toLayer(({ run }) =>
  Effect.scoped(Effect.gen(function*() {
    const remotes = yield* Remotes.Remotes
    const session = yield* remotes.acquire("fuzz", `fuzz-campaign-${run}`)
    const process = yield* session.spawn("go version", {})
    return yield* Stream.mkString(Stream.decodeText(process.stdout))
  }))
)
```

`acquire(remote, session)` is scoped: the session lasts as long as the scope.
Hand the session to `Sandbox.hostContext` to give a body the machine's
`FileSystem` and `ChildProcessSpawner`, as
[Place a flow body on a machine](./place-a-flow-body-on-a-machine.md) does.

| What the host does    | Detail                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checks the grant      | `remote:acquire:<name>` against the calling action's ceiling, before anything reaches the machine. A refusal is a `PermissionDenied` naming the capability. |
| Reads the declaration | `WORKSPACE.ts` is evaluated on the first `acquire`, not at startup. A file that does not evaluate fails that `acquire` with `unavailable`.                  |
| Picks a machine       | A command remote with several machines places each session key on one of them by its digest, so a retried action lands where it was.                        |
| Picks a directory     | `<workdir>/<key's name-safe characters>-<12 hex digits>`, created on the machine. The same key reuses it.                                                   |
| Starts the transport  | With the host's own spawner, outside the confinement. An HTTP remote reads its token from the variable its `S.Secret` names.                                |

A name the workspace does not declare fails with `not_found`, and the message
lists the names it does declare.

## What this does not do

The machine is not confined by Smithers. Whatever the session runs has the
authority of the account the transport logs into. Grant `remote:acquire` only
to flows you would let run commands there.
