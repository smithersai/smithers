---
title: "The host bundle"
description: "Why the Host surface is a closed set of five tags, which of them this package composes and which it implements, and how the native filesystem and process adapters differ across platforms."
sidebar:
  order: 1
---

A Smithers **host** is the boundary between a durable flow and the machine
underneath it. The surface is closed: five service tags, no more, and
[`@smthrs/kernel`](/api/kernel) owns the list.

```text
FileSystem  Path  ChildProcessSpawner  Jj  HttpClient
```

Closing the list is what makes the capability check complete. The kernel
decorates each of the five with a permission check, so a program that reaches
the machine has to go through a tag the kernel is watching. A sixth capability
smuggled in beside them would be authority nobody checked.

Four of the five tags are Effect's own, from `effect/FileSystem`,
`effect/Path`, and `effect/process/ChildProcessSpawner` and
`effect/http/HttpClient`. Smithers provides implementations of them
rather than wrappers around them, so an ordinary Effect program runs on a
Smithers host unchanged. `Jj` is the one Smithers tag, and it lives in
[`@smthrs/jj`](/api/jj).

## What this package composes

`@effect/platform-node` already ships most of a Node host. `NodeHost.layer` is
mostly assembly:

| Tag                   | Implementation                          |
| --------------------- | --------------------------------------- |
| `Path`                | `NodePath.layer`                        |
| `ChildProcessSpawner` | `NodeChildProcessSpawner.layer`         |
| `HttpClient`          | `EgressHttpClient.layer(process.env)`   |
| `Jj`                  | `@smthrs/jj`'s `NodeJj.layer`           |
| `FileSystem`          | this package's `AtomicFileSystem.layer` |

Only the filesystem slot is this package's own implementation, and
[it exists because Node cannot express what the kernel needs](./descriptor-relative-filesystem.md).

The HTTP slot is Undici either way. `EgressHttpClient.layer` routes it through
the egress proxy `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` name, and is exactly
`NodeHttpClient.layerUndici` when they name none, so an unproxied host is
unchanged. A bundle spans a whole host, and a host may be a sandbox whose only
way out is that proxy; a bare Undici `Agent` reads none of those variables and
dials every origin directly, which such a host drops.

The same layer provides `EgressHttpClient.resolveHost`, the system resolver, as
[`@smthrs/kernel`](/api/kernel)'s `HttpClient.ResolveHost`. That is a context
reference with a default, not a sixth tag: the default refuses every name, which
is the right answer where the platform mediates the network. The web tools in
[`@smthrs/std`](/api/std) check every address it returns, and the client pins
the connection to those addresses, so the resolver and the client have to come
from one layer.

`NodeHost` re-exports the pieces it composes, so a program that wants one slot
rather than the whole bundle needs no second dependency:
`NodeHost.AtomicFileSystem`, `NodeHost.ProcessReaper`, `NodeHost.NodeCrypto`,
`NodeHost.NodeFileSystem`, `NodeHost.NodeChildProcessSpawner`,
`NodeHost.NodeHttpClient`, and `NodeHost.EgressHttpClient`.

`NodeCrypto` is there for a different reason from the rest. `Crypto` is not a
Host service: it carries no host authority the kernel could attenuate, so it is
not in the closed list. Every durable composition needs one anyway, and a
program that already depends on this package for its host should not need a
second dependency for the digest.

## The four layers

The bundle ships four layers, along two independent axes: where `Jj` is rooted,
and whether spawned processes are contained.

| Layer                                       | `Jj` bound to                 | Containment |
| ------------------------------------------- | ----------------------------- | ----------- |
| `NodeHost.layer`                            | the process working directory | no          |
| `NodeHost.layerAt(root)`                    | one absolute repository root  | no          |
| `NodeHost.layerContained(options?)`         | the process working directory | yes         |
| `NodeHost.layerContainedAt(root, options?)` | one absolute repository root  | yes         |

The rooted pair exists because a durable host outlives any one working
directory. This package's `NodeRuntime` composes `layerContainedAt`, so both
the repository and the process containment are pinned by the runtime rather
than inherited from whatever shell started it.

Both rooted factories return a layer immediately. A relative or empty root
fails layer construction with typed `NodeHostError` (`invalid_repository_root`),
so callers can recover through Effect without catching synchronous exceptions.
The diagnostic does not echo the configured path.

The contained pair carries a requirement the plain pair does not: a
`ProcessLedger`. See [Process containment](./process-containment.md) for what
it buys and why the ledger is not defaulted.

## What the bundle does not provide

Each of these is a decision with a consequence, not a gap.

**There is no shell service.** Running a command is Effect's `ChildProcess` and
`ChildProcessSpawner`. That means a wall-clock budget is `Effect.timeout`
around the effect rather than an option on a command record, and cancellation
is fiber interruption rather than an `AbortSignal`. A Smithers shell service
would be a second way to express what Effect already expresses, and the kernel
would then have two spawn paths to check instead of one.

**There is no HTTP service.** An outgoing request is Effect's `HttpClient`, and
`@effect/platform-node` already ships the Undici-backed implementation. Undici
follows no redirect unless a redirect interceptor is installed, and this bundle
installs none, so every hop stays a separate request. That is what lets the
kernel check `net:get` and `net:post` against the host of every URL a request
actually reaches, redirect targets included.

**Native adapters differ across platforms.** `AtomicFileSystem` uses the
packaged native helper, including the Windows x64 executable. Missing or
unusable helpers fail guarded operations closed on every platform.
`ProcessReaper` reads Linux identities from `/proc`, uses `ps` on other POSIX
hosts, and asks the native helper's `--process-info` probe on Windows.
Windows cleanup uses `taskkill /T /F` after verifying the recorded identity
and refusing the host's own pid.

**There is no path-based fallback.** A host with no usable `smithers-jj-export` helper fails
every guarded filesystem call with `PermissionDenied`. The adapter never
degrades to a check-then-path operation, because that is exactly the race it
exists to close.

## Conformance

The bundle is not trusted to be correct because it is composed correctly. It
runs the shared host contract from `@smthrs/kernel/test/contract` twice: once
with explicit expectations, and once taking every default the suite offers,
against a loopback HTTP server so the `HttpClient` success path is asserted
rather than only its refusal.

On top of that, the atomic filesystem is compared row by row against
`@effect/platform-node`'s own adapter (open flags, errno classification, `stat`
fields, and the glob grammar), and containment is driven over real detached
process groups.

## Sandbox authority

Seatbelt retains declared file reads individually; it never promotes a set of
files to a directory grant. New children therefore need their own declaration.
Large profiles can be refused by the platform compiler rather than widen access.
A workspace symlink does not add its target to `externalReads`: access outside
the workspace, including credential locations, requires an explicit external
declaration.

A directory write that names an existing file is refused. Use `writeFiles` to
explicitly grant the parent needed for file creation and replacement. Bubblewrap
refuses rendering when a missing `readOnly` entry lies beneath a writable mount;
it cannot skip that protection. Docker refuses loopback-only networking both
when selecting a mechanism and when rendering a plan.
