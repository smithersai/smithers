---
title: "Version control as a capability"
description: "Why jj is a service behind a layer rather than a spawn: the eight operations of the Jj contract, the optional members, feature detection by error code, and the capability grants the kernel checks."
sidebar:
  order: 1
---

Smithers, the durable flow engine this package belongs to, snapshots the
working copy around every step so a step that goes wrong can be put back. An
orchestrator that calls `spawn("jj", ...)` from inside a step gets the snapshot
and gives up everything a host needs to reason about it: which repository was
touched, whether the operator authorized it, whether the child is inside the
process ledger, and what the failure meant. `Jj` is the same operations expressed as a
service, so the host decides all of that in one place.

## One small contract

The interface is deliberately small. It holds only the operations that make a
step reversible, and nothing that merely happens to be a jj subcommand:

| Operation                        | What it does                                                            |
| -------------------------------- | ----------------------------------------------------------------------- |
| `snapshot(message?)`             | Commits the working copy and returns the commit id to restore to later. |
| `restore(revision)`              | Puts the working copy back to that revision.                            |
| `diff(from, to)`                 | Git-format unified diff between two revisions.                          |
| `workspaceAdd(name, path, rev?)` | Adds a named workspace rooted at `path`, one lane per parallel agent.   |
| `workspaceForget(name)`          | Drops a named workspace without touching the commits made in it.        |
| `status()`                       | The working copy's status, as jj prints it.                             |
| `root(from)`                     | The repository root that contains a path.                               |
| `revert(revision)`               | Applies the reverse of one change and reports the paths that changed.   |

There is no `commit`, no `push`, no `log`. Adding one would mean every backend
owes an answer for it, including the WebAssembly build in a browser tab, so the
contract stays at what a reversible step actually needs. Everything above is
what [`@smthrs/time-travel`](/api/time-travel) uses to fork a run into a lane
and rewind it.

## Every method's error channel is JjFailure

`JjFailure` is `JjError | Permission.PermissionError`. Both halves are declared
here, in the package that owns the service, rather than being redeclared by the
kernel that adds the second one. The consequence is that a caller holding `Jj`
cannot forget a snapshot may be denied by the permission kernel rather than by
jj, because the type says so before any kernel is in the composition.

`workspaceAdd` and `root` add `PlatformError` on top. The guarded
implementation canonicalizes a path against the workspace root before it asks
for a grant, and resolving a path is itself a filesystem operation that can
fail.

## Two members are optional, and none of them is absent

`root` and `revert` are optional on the type, so a hand-written test double may
leave them out. Every layer this package ships defines both anyway, and answers
in the error channel where the backend cannot perform them.

That makes property presence useless as a probe. `"revert" in jj` is true for
`makeNoop`, for `BrowserJj.make`, and for `BrowserJj.layerUnsupported` alike.

**Feature detection is by error code, never by property absence.** A caller that
needs to know calls the method and reads the code it gets back:
`not_installed` means this host cannot do it. An absent capability is a
capability with an answer.

The one place absence still travels is the kernel decorator, which forwards a
missing `root` or `revert` as missing rather than replacing it with a guarded
method that fails on call. Turning "this host has no revert" into "your revert
was refused" would be a different answer to a caller deciding what it can
offer.

## Why restore and revert both exist

Neither expresses the other.

`restore` moves the working copy back to a recorded point, which also discards
everything committed after it. That is what an engine wants when it rewinds a
run to a checkpoint.

`revert` undoes one change and keeps the rest, which is what an operator means
by "undo that attempt". It also reports the paths it touched, because the
caller has to be able to say what was undone. The paths are read before the
revert runs, so the answer is the paths the reverted change touched rather than
a fact about where the revert landed.

## The grants the kernel checks

[`@smthrs/kernel`](/api/kernel) provides a layer over this same tag that reads
the raw service out of context and returns a guarded one in its place. There is
no second interface and no second tag. Each operation asks for one capability
before it runs:

| Operation         | Capability            | Effect tier   |
| ----------------- | --------------------- | ------------- |
| `status`          | `jj:status`           | `sealed`      |
| `diff`            | `jj:diff`             | `sealed`      |
| `root`            | `jj:root`             | `sealed`      |
| `snapshot`        | `jj:snapshot`         | `compensable` |
| `restore`         | `jj:restore`          | `compensable` |
| `workspaceAdd`    | `jj:workspace-add`    | `compensable` |
| `workspaceForget` | `jj:workspace-forget` | `compensable` |
| `revert`          | `jj:revert`           | `compensable` |

The three reads are `sealed`, so their results are content addressable and
replay from the journal. The five writes are `compensable`, so the engine can
undo them.

`workspaceAdd` asks for two grants, `jj:workspace-add` and `fs:write`, and
canonicalizes the destination through the raw filesystem before either check.
It then canonicalizes again and refuses if the answer moved, so an existing
symlink cannot turn an inside-workspace grant into outside authority. `root`
canonicalizes its starting directory for the same reason: the grant has to name
the directory jj is actually run in, not a symlink alias of it.

For the whole permission model, see
[Capabilities and the host kernel](/docs/concepts/kernel/).

## Durable identity

The tag key `@smthrs/jj/Jj` and the error `_tag` `@smthrs/jj/JjError` are
durable identity, not implementation detail. Step keys digest the resolved
service set, and `JjError` round-trips through the journal, so renaming either
one invalidates recorded runs.
[test/index.test.ts](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/jj/test/index.test.ts)
pins both for exactly that reason. See
[Content addressing](/docs/concepts/content-addressing/).
