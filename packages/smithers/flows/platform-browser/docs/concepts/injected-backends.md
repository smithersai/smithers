---
title: "Injected backends"
description: "Why the browser layers are functions rather than values: the two structural slices, the one-mount rule that binds them, what degrades when a slice omits an optional member, and who owns durability."
sidebar:
  order: 1
---

`NodeServices.layer` is a value. `BrowserServices.layer` is a function of
`{ bash, fs }`, and `BrowserHost.layer` is a function of `{ bash, fs, jj }`.
The difference is the model this package is built on: a Node adapter opens the
machine, which is already there, while a browser adapter opens whatever the page
mounted, which only the page knows.

## The backends are arguments, not imports

Neither `@zenfs/core` nor `just-bash` appears in this package's dependency list.
Each is taken as a **structural slice**: an interface naming only the members
the adapter calls, under the names the real backend uses.

| Slice               | Satisfied by                                                      | Members                                                                                      |
| ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ZenFsPromisesLike` | `@zenfs/core`'s `fs.promises`, and Node's own `node:fs/promises`. | `open`, `readFile`, `writeFile`, `mkdir`, `readdir`, `stat`, `rm`, and two optional members. |
| `JustBashLike`      | just-bash's `Bash` class (`new Bash({ fs })`).                    | `exec(commandLine, options?)`.                                                               |

Taking the instance rather than the package buys three things. The page decides
which ZenFS backend is mounted, and when. The bundle carries no vendor code this
package chose for it. And a test satisfies either slice with an object literal,
or runs the filesystem against a real directory by passing Node's own
`node:fs/promises`.

## The one-mount rule

A composition can hold three views of a filesystem, and they must be views of
the same one:

| View                           | Who uses it               | Shape                                    |
| ------------------------------ | ------------------------- | ---------------------------------------- |
| `fs`, the promises API         | `BrowserFileSystem`       | `node:fs/promises`-shaped, asynchronous. |
| The filesystem inside `bash`   | the interpreter           | whatever just-bash was constructed over. |
| `jj.fs`, the synchronous slice | `BrowserJj`, through WASI | `node:fs`-shaped, synchronous.           |

jj needs the synchronous one because WASI preview 1 is a synchronous syscall
ABI, so the same mount is taken twice, once per shape. Split any of the three
and the failure is not a crash: a command writes a file no reader can see, or jj
snapshots a tree the flow never wrote. The layer signatures make the pairing an
explicit decision at the one place a caller can still get it right.

## Optional members change the answer, not the contract

`ZenFsPromisesLike` marks `lstat`, `realpath`, `rename`, and `utimes` optional
so minimal adapters can still provide supported operations.

- Without `realpath`, `realPath` fails with `PermissionDenied`; omitting the
  method does not prove the backend lacks symlinks.
- Without `rename` or `utimes`, artifact publication is unavailable; each
  operation fails typed with `PermissionDenied` naming the missing method.
- Without `lstat`, a recursive `readDirectory` classifies entries with `stat`
  and therefore follows a directory link. The walk refuses to revisit a
  directory it has already canonicalized, and a backend supplying neither member
  is capped at 128 levels, which is the only case that cap applies to.
- Without `lstat`, `FileSystem.lstat` answers with `stat`. A backend that has
  links must supply `lstat`, or a link reads as its target.

Both `@zenfs/core` and `node:fs/promises` provide both members.

## The interpreter must settle after an abort

`JustBashLike.exec` carries one requirement beyond its signature: the returned
promise must settle once `signal` aborts. The adapter serializes runs behind a
permit so two interpreters never mutate the mount at once, and it holds that
permit until the promise settles rather than until the calling fiber stops
waiting. An interpreter that ignores its `AbortSignal` and never resolves
therefore blocks every later run, which is the honest outcome: the alternative
is releasing the permit with a write still in flight and letting a second
interpreter run over it.

## Values cross the boundary by value

The adapter neither trusts the backend with its callers' memory nor trusts its
callers with the backend's. `writeFile` copies `data` and reads `flag` and
`mode` when it is called, so the effect it returns describes one write however
the caller's buffer changes before it runs or between retries. `readFile` and
`readDirectory` return a buffer and an array the caller owns, so a backend that
answers from its own storage can neither be corrupted through a result nor
change one already returned.

## Durability belongs to the page

ZenFS fronts IndexedDB and OPFS with a synchronous mirror and writes back
asynchronously. That mirror is what lets jj-lib run without threads, and it
means a returned write is not yet a stored write. Call the mount's `sync()`
after writes that must survive a reload. This package does not own the mount and
never syncs on your behalf.
