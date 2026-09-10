---
title: "How a remote command differs from a local one"
description: "The divergences between a sandboxed command and a local child process: a stdin blob instead of a pipe, no process identity, declared refusals, and two differences the error channel cannot report."
sidebar:
  order: 4
---

`RemoteChildProcessSpawner.layer` produces Effect's `ChildProcessSpawner`, so
an existing `ChildProcess` command runs against a sandbox the way it runs under
`NodeChildProcessSpawner`. It is not the same thing, and the differences are
declared rather than hidden.

A remote session is reached by sending it one rendered command line. There is
no local process to hold onto, which is where every item below comes from.

## Standard input is a blob, not a pipe

A provider that declares `stdin: true` receives the command's complete standard
input as bytes in `RemoteOptions.stdin`. Collection is bounded at 16 MiB and
the count runs as the bytes arrive, so an oversized or endless producer is
stopped at the bound rather than after it finishes.

Each accepted chunk is copied on arrival, including Node `Buffer` chunks.
Producers may reuse their input buffer after each chunk has been consumed.

The handle's own `stdin` sink always fails: there is no interactive channel
either way. A command that pipes input into a long-running process and reads
its answers cannot work here, and no arrangement of options makes it work.

For a `Sandbox.Provider`, delivery is an obligation rather than a declaration:
a transport with no input channel stages the bytes as a workspace file and
redirects the command from it.

## There is no process identity

`pid` is a synthetic id allocated per spawner layer, not a pid on either side
of the seam, and `unref` is a no-op, because this process holds no reference
to a remote one.

## Signals exist only where a provider declares kill

A remote process normally ends by closing its scope, which runs the provider's
cancellation finalizer. When the provider declares `kill`, the adapter maps
`ChildProcessHandle.kill` onto it and signals a still-running command when the
scope closes, ahead of the provider's own release finalizer; a process this
side has already seen exit is left alone. When it does not, `kill` fails rather
than pretending to have delivered a signal.

## Refusals, and why each one is a refusal

Each of these fails with a `BadArgument` `PlatformError` before the provider is
asked to start anything.

| Refused                                                           | Why                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| a stdin stream for a provider that does not declare `stdin: true` | the bytes would be silently lost                                                                           |
| a stdin stream on any stage of a pipeline but the first           | a later stage reads its predecessor                                                                        |
| `stdin: "inherit"`                                                | a local spawner hands the child this process's own standard input; a remote command would read EOF instead |
| additional file descriptors                                       | nothing carries them across                                                                                |
| a shell path, or `detached: true`                                 | the local host's vocabulary                                                                                |
| non-default pipeline routing (`from`, `to`)                       | the rendered line reaches the remote shell, not this adapter                                               |
| `kill` on a provider that declares none                           | no signal can be delivered                                                                                 |

`stdin: "pipe"`, `"ignore"`, and `"overlapped"` are accepted, and all three
mean the command reads no input, which is what they mean locally. Output
`pipe`, `ignore`, and `inherit` options and output sinks are honored by the
adapter, and `"inherit"` and `"ignore"` yield an empty stream exactly as they
do under `NodeChildProcessSpawner`. An unconfigured extra descriptor answers
`Sink.drain` and `Stream.empty`, the same answer a local spawner gives.

## Two divergences the error channel cannot report

These cannot be refused, because nothing in the call says they are happening.

- **`extendEnv` is ignored.** The remote session's ambient environment never
  crosses the seam, so only the `env` overrides travel, and `extendEnv: false`
  cannot clear an environment this side never held.
- **`isRunning` answers from what this side has observed.** Nothing pushes an
  exit across the seam, so the adapter forks a scoped observer of the
  provider's exit at spawn and memoizes it. Liveness turns `false` when that
  observation lands, which can lag the remote process by a scheduler tick, and
  does not depend on a caller reading `exitCode`.

## A pipeline is one line

A `PipedCommand` is rendered into the single command line the remote side
parses, so the `|` reaches the remote shell rather than this adapter. That is
also why standard input can only be fed to the first stage, and why a
non-default `from` or `to` is refused: it cannot survive the rendering.

## Environment names are checked before the command runs

Every provider runs the caller's command through a shell, and a shell rebuilds
its environment from names matching `[A-Za-z_][A-Za-z0-9_]*` when it starts.
`a-b=1` is delivered to the process and then discarded by the shell that
interprets the command, on dash but not on bash. A spawn carrying such a name
is refused with `spawn_error` naming it, on every provider and both platforms,
rather than losing the variable in the guest.

An entry set to `undefined` requests deletion of an inherited variable for
that command. Removing a command default alone does not clear guest inheritance.

| Provider                                                                  | Deletion behavior                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DirectorySandbox`                                                        | Removes the entry from the child environment before spawning.                                                                                                                                                 |
| `ContainerSandbox`, `KubernetesSandbox`                                   | Uses guest `env -u` before the command shell.                                                                                                                                                                 |
| `AwsSandbox`                                                              | Uses guest `env -u`; environment overrides require `exec.streamingSpawner`, otherwise `unavailable`.                                                                                                          |
| `CloudflareSandbox` (exec and process), `VercelSandbox`, `DaytonaSandbox` | Uses `/usr/bin/env -u NAME ... /bin/sh -c ...` in the guest, with removals before assignments. Requires those guest executables.                                                                              |
| `MicrosandboxSandbox`                                                     | Uses guest `/usr/bin/env -u` before the configured command shell, including inside `nix develop`. Requires guest `/usr/bin/env`; refuses deletion with `spawn_error` if the configured shell is not absolute. |
| `JustBashSandbox`                                                         | Refuses with `ProviderError` code `spawn_error` before interpreter execution. Its injected interface only merges string values.                                                                               |

`SandboxConformance` checks that guest `HOME` exists before requesting its
deletion, then requires absence or a typed spawn refusal. Provision test guests
with `HOME` set. This check is separate from environment delivery and removal
of provider command defaults.

## Read next

- [Run commands through a transport](../guides/run-commands-through-a-transport.md).
- [Limits](../limits.md): the bounds these divergences are measured against.
