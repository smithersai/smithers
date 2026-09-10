---
title: "The browser host contract"
description: "What BrowserHost guarantees where it diverges from NodeHost: the filesystem options a mounted volume honours, the operations it refuses, and the spawner's one-run-at-a-time abort boundary."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-browser/docs/contract.md"
---

The governing statement for `@smthrs/platform-browser`: what a program gets when
it runs on `BrowserHost` instead of [`NodeHost`](https://platform-node.smithers.sh/reference/api/), what you
have to supply for those promises to hold, and where they stop. Every service
here is an adapter over a backend the page passes in, so each guarantee below is
about the adapter, and the parts a backend owns are named as such.

```ts
import * as BrowserHost from "@smthrs/platform-browser/BrowserHost"

/** One isolated mount; /repo already exists. See Compose the browser host bundle. */
const layer = BrowserHost.layer({ bash, fs: fs.promises, jj: { wasm, fs, root: "/repo" } })
```

The FileSystem isolation root is always the mount root `/`. `jj.root` selects
the repository directory inside that mount; it does not narrow FileSystem
isolation. Use one workspace per isolated mount.

## What the bundle provides

`BrowserHost.layer` provides exactly five service tags: `FileSystem`, `Path`,
`ChildProcessSpawner`, `Jj`, and `HttpClient`. A program written against those
tags runs unchanged on a server or in a tab.
[The closed Host surface](/concepts/host-bundle/) says what backs each one.
`BrowserServices.layer({ bash, fs })` provides the first three, for a page that
wants Effect's platform services and nothing more.

## What the package guarantees

- **Options are honoured, not dropped.** `makeDirectory` forwards `mode`,
  `writeFile` forwards `flag` and `mode`, `access` answers `readable` and
  `writable` from the reported mode bits, `stream` honours `offset`,
  `bytesToRead`, and `chunkSize`, and a recursive `readDirectory` is walked here
  because the promises slice has no recursive `readdir`.
- **`realPath` canonicalizes.** Symlinks are followed when the backend has
  `realpath`, and a `..` after a link names the parent of the link's target
  rather than being collapsed lexically first. This is the boundary
  [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) resolves a guarded path through before it
  checks the grant. Without `realpath`, `realPath` fails with a `PermissionDenied`
  `PlatformError`; there is no fallback.
- **A refusal is typed, never silent.** The operations a promises-shaped volume
  cannot serve, symlink creation and writable handles and watchers among them,
  fail with a `PermissionDenied` `PlatformError` naming the method.
  `rename` and `utimes` are served when the backend supplies them; otherwise
  they fail with the same refusal. `NotFound` is reserved for a path the backend
  reports absent.
  [Read and write files on a mounted volume](/guides/work-with-files/#what-fails-and-how)
  lists every one with the served operation to use instead.
- **Backend errors keep their meaning.** `ENOENT` becomes `NotFound`, `EEXIST`
  `AlreadyExists`, `EACCES` and `EPERM` `PermissionDenied`, `EISDIR`, `ENOTDIR`,
  and `ELOOP` `BadResource`, `EBUSY` `Busy`, and anything else `Unknown`, with
  the original kept as the `cause`. `exists` reports `false` only for an absent
  path, so a refusal to look is never reported as absence.
- **Bytes and names cross by value.** `writeFile` copies `data` and reads its
  options when it is called, and `readFile`, `readDirectory`, and `stream`
  return buffers and arrays the caller owns.
- **One command at a time.** The spawner holds a permit until the interpreter's
  promise settles, abort included, so two runs never mutate the mount at once.
- **An abort is reported, not replayed.** Interruption, a timeout, and `kill`
  abort the interpreter through its `AbortSignal`, and every observable on the
  handle then reports a `PlatformError` naming the abort rather than interrupting
  the caller's fiber.
- **The command line is the one a grant is checked against.** A command is
  rendered by `@smthrs/kernel`'s `CommandLine.render` before the interpreter sees
  it, POSIX single-quoted without `shell` so argv semantics survive, and joined
  verbatim with `shell`.
- **A redirect is never followed here.** The bundle's `HttpClient` is Effect's
  fetch client with `RequestInit { redirect: "manual" }`, so the host client
  hands a redirect back rather than walking to a second origin the grant never
  named.
- **Nothing resolves a `node:` built-in.** Every entry point bundles for a
  browser, `BrowserHost` included.

## What you supply for those to hold

| You supply                                                             | What breaks without it                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| One mount behind `bash`, `fs`, and `jj.fs`                             | Nothing raises. A command writes a file no reader sees, or jj snapshots a tree never written.     |
| `realpath` for canonicalization                                       | `realPath` fails with `PermissionDenied`; there is no fallback.                                    |
| An `exec` whose promise settles once its `AbortSignal` fires           | The permit is never released, and every later run blocks.                                         |
| A volume that addresses nothing outside itself, if you compose `layer` | The isolation attestation is false, and the capability kernel resolves paths it should not trust. |
| The mount's `sync()` after writes that must survive a reload           | An acknowledged write is still only in the synchronous mirror.                                    |

[Injected backends](/concepts/injected-backends/) covers the one-mount rule,
the optional slice members, the abort requirement, and durability.
[The isolation attestation](/concepts/isolation-attestation/) covers the claim
`layer` makes on your behalf.

## What the host does not promise

- **Live output.** The interpreter runs to completion, so `stdout` and `stderr`
  each emit one chunk after it finishes, and `all` is `stdout` then `stderr`
  rather than an interleaving.
- **A process table.** `pid` is a per-layer counter, `unref` is a no-op,
  `killSignal` is ignored, `forceKillAfter` is rejected, a piped command is
  rejected, and a command supplying a stdin `Stream` is rejected at spawn.
- **A working directory.** A tab has no `process.cwd()`, so `cwd` and a relative
  path handed to `realPath` resolve against the volume root. Pass absolute
  virtual paths.
- **Bounded captured output.** `stream` allocates at most 64 MiB per chunk, but
  the interpreter's complete `stdout` and `stderr` are held in the tab's heap.
  Bound the command instead.
- **Durability.** The page owns the mount, and this package never syncs on your
  behalf.
- **A readable redirect in a tab.** Under the Fetch standard, a manual redirect
  yields an opaque-redirect response with status `0` and no headers, so a
  redirect fails closed in a browser rather than being followed.

## Next steps

- [Compose the browser host bundle](/guides/compose-the-host/): the three
  arguments, in the order a page assembles them.
- [API reference](/reference/api/): every export, every option, every divergence.
- [Troubleshooting](/troubleshooting/): each refusal above as a symptom, with
  its cause and its fix.
