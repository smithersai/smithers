---
title: "@smthrs/platform-cloudflare"
description: "Run the durable flow engine in Cloudflare Workers and Durable Objects: one object per execution, woken by its alarm, over Postgres through Hyperdrive."
---

`@smthrs/platform-cloudflare` runs Smithers' durable flow engine on Cloudflare.
One Durable Object drives one flow execution. It stores what to run, wakes
itself with its alarm, and builds the same durable runtime the Node and Bun
hosts build, over Postgres through Hyperdrive.

## What it solves

A Worker invocation ends when its response does, and `waitUntil` work dies with
the isolate. Work that must finish, such as an answer that streams from a model
for a minute, needs something that wakes it again after an eviction, a reset or
a deploy, and something that knows how far it got.

The flow engine already knows how far a run got: its journal, leases, attempts
and timers live in Postgres. What a Worker lacks is a process that drives the
run and comes back when it stops. This package supplies that host:

- `ExecutionObject` turns a Durable Object into the driver of one execution. Its
  alarm is the wake-up, and the engine's own store decides what the wake does.
- `CloudflareRuntime` builds the engine for that one execution, inside the
  alarm, over an injected `SqlClient`.
- `CloudflareHost` is the closed Host surface the engine composes over: WebCrypto,
  `fetch` and POSIX paths, with the filesystem, processes and jj present and
  refusing.
- `EdgeCache` is the edge cache: `@smthrs/artifacts`' `ImmutableCache` over the
  Workers Cache API, for content that never changes at its key, such as a file
  at a commit SHA.
- `SandboxObject` wakes a container Durable Object's container: it starts it
  with internet access off, re-arms its inactivity timeout, and registers the
  outbound HTTP intercepts that are its only way out.
- `ContainerTerminal` gives that container browser terminals: one tmux session
  per terminal and one tmux client per WebSocket, where the owner types and
  everyone else watches.
- `ContainerSession` is that container as `@smthrs/sandbox`'s
  `Sandbox.Session`, so its `SandboxTools` (run a command, read, write and list
  files, git status and diff) run in it as one user.

## Install

[Installation](./installation.md) covers the packages, the Worker's
compatibility flags and the database.

## Next steps

- [Quickstart](./quickstart.md): a flow, a Durable Object and the Worker that
  starts it.
- [The execution lifecycle](./concepts/execution-lifecycle.md): what `start`
  and `alarm` do, how a dead incarnation is replaced, and what each guarantee
  rests on.
- [The Cloudflare Host surface](./concepts/host-surface.md): what each Host
  service does on a Worker.
- [Host a flow in a Durable Object](./guides/host-a-flow-in-a-durable-object.md):
  the Alchemy wiring, binding and Hyperdrive included.
- [Attach a terminal to a container](./guides/attach-a-terminal-to-a-container.md):
  wake a container offline, create a tmux session, and bridge each viewer's
  WebSocket.
- [Measure a sandbox command's overhead](./guides/command-latency.md): the
  benchmark of a run's call of a sandbox command, its method and numbers.
- [Troubleshooting](./troubleshooting.md): every `Retrying` failure and what
  resolves it.
- [API reference](./api.md): every public export.

Host failure diagnostics use `RetryPolicy.failureType` from `@smthrs/flow`: the squashed error’s tag or name, or `unknown`, without its message or stack.

`CloudflareRuntime.layer` injects the Durable Object's `hostId` as journal-decode
`objectId`. Set `codeVersion` to the deployed commit, or provide
`JournalDecode.Identity` around the runtime to supply its code version. A decode
refusal records the object, code and fixed step tag without the stored payload.

The Postgres child-alarm regression allows 195 round trips: the earlier 193 plus
the two required unknown-run guards introduced by 53466ad8. It checks those guards
explicitly; this baseline adjustment changes no runtime behavior.

The real-process container test fixture keeps native stdin errors in its Effect
error channel, including when a command closes its pipe before accepting input.
A closed-pipe regression uses a real child process; no request is intercepted.
