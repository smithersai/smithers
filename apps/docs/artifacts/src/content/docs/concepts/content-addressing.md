---
title: "Content addressing"
description: "Why an artifact's address is a measurement of its bytes, what that buys, and the four invariants the store enforces to keep an address and its content from ever disagreeing."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/artifacts/docs/concepts/content-addressing.md"
---

An artifact has no name. Its address is the SHA-256 digest of its own bytes,
spelled as 64 lowercase hexadecimal characters, and the store computed it by
hashing what the caller handed over. That single decision is where every other
property in this package comes from.

Three things follow immediately. Two callers who produce the same bytes produce
the same address, so storing the second copy is free. An address is a proof
obligation the store can check at any moment, so a read can verify rather than
trust. And a digest is safe to write into a durable row, ship over a network,
or print in a log, because it reveals nothing about where the bytes live or who
produced them.

Smithers uses the same idea one layer up: a step key is derived from canonical
content rather than from an activity's name, which is what
[content addressing on smithers.sh](https://smithers.sh/docs/concepts/content-addressing/)
describes. This package is the byte-level half of that story.

## A digest is a value, and an untrusted one

`ArtifactStore.Digest` is both the branded type and the schema for the
canonical representation. `put` returns the brand, because it measured the
bytes itself and can vouch for the form.

Every read operation accepts a plain `string` instead. That is deliberate: a
digest read back out of a durable row, a cache entry, or an HTTP body is
untrusted input, and asking every caller to re-brand a persisted column would
only move the trust question somewhere less careful. The store validates
instead. `ArtifactStore.validateDigest` refuses anything that is not exactly 64
lowercase hexadecimal characters, and it runs before any implementation logs a
digest or interpolates one into a path or a URL:

```ts
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as Effect from "effect/Effect"

/** Prints `invalid_digest` rather than reaching for `../../etc/passwd`. */
const checked = ArtifactStore.validateDigest("../../etc/passwd").pipe(
  Effect.catchTag("@smthrs/artifacts/ArtifactStoreError", (failure) => Effect.succeed(failure.code))
)

console.log(await Effect.runPromise(checked))
```

The failure message is a constant. A hostile multi-megabyte value cannot copy
itself into a log line or a durable error by being rejected.

## The four invariants

### Every read is digest verified

`get` measures the bytes it found and compares them against the address it was
asked for. A mismatch is `ArtifactCorruption`, carrying both the recorded and
the measured digest, and the bytes are never returned. This is what makes a
truncated blob from a crashing writer, a failing disk, or a shared tier serving
the wrong object into a loud failure rather than a silently wrong replay.

The in-memory store is the deliberate exception. Its address space is a private
`Map` keyed by the digest it measured on the way in, `put` stores a copy of the
caller's array, and `get` hands out a copy of the stored one. No reference a
caller can still mutate aliases the stored content, so there is no window in
which the address and the content can disagree. The filesystem and HTTP stores
verify because their address spaces are genuinely shared.

### Publication is atomic

A plain write to the canonical path could be observed, or survive a crash, as a
partial file that every later read of that digest would trust. The filesystem
store instead writes to a temp path inside the destination fanout directory,
fsyncs it, and renames it into place. The rename never crosses a filesystem
because the temp path is a sibling of the blob.

Temp names carry a random per-store token drawn from Effect's `Random`, so two
processes publishing the same digest into one workspace never share a scratch
path and never clobber each other into torn bytes at the content address. The
token enters no persisted identity, so its randomness is invisible to replay.

`FileSystemOptions.durability` controls the fsync. `required`, the default,
reports success only after syncing the blob, its fanout directory, the objects
directory, and each ancestor through the relative or filesystem root. This
persists new fanout and lock directory entries and nested configured directories.
Every put repeats these barriers, including a deduplicated retry after an
interrupted publication. A sync refusal fails with `ArtifactStoreError` code
`unavailable`. `best-effort` is the explicit weaker capability for a
host that cannot sync file or directory handles. Both modes require exclusive
writable handles and symlink inspection; unsupported hosts fail as `unavailable`.

### An existing blob is verified on every put

The store does not treat "the path exists" as "the bytes are correct", and it
does not remember a verification it already did. The objects directory is
shared by the whole workspace, so a blob can change behind one store's back. A
remembered proof would let a later put report success over corrupt bytes
without repairing them, and `get` would then refuse that digest forever even
though every put held the cure.

So every put reads the existing blob, measures it, and only skips the write on
a verified match. A mismatch, or a read the host refuses, falls through to the
atomic rewrite and heals the address. Re-verifying costs a constant factor, not
a new asymptote: a put already pays one hash over its own input.

### A deduplicated put freshens the blob

When a put deduplicates, the store stamps the blob's modification time. This is
git's loose-object freshening, and the touch Bazel's disk cache performs on a
hit. It matters because mtime is the age evidence a retention sweep fences its
deletions on. Re-publishing old bytes has to read as a recent reference, or the
grace period cannot protect the cache entry recorded moments later.

The freshen is best effort. On a host with no `utimes`, a failure over a blob
that still exists keeps the dedupe skip and accepts git's own
freshen-versus-prune race. A failure over a blob that vanished, because a sweep
won, falls through to the atomic rewrite instead.

## What an address does not tell you

An address says what the bytes are. It says nothing about whether anything
still wants them. This package therefore never reclaims a published artifact as
a side effect of a store call: `ArtifactSweep` is the deletion surface, and the
mark phase that decides which digests are live belongs to
[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `ArtifactGc`, the only place the
durable roots are visible. See
[Reclaim disk space](/guides/reclaim-disk-space/).

The one thing a store does clean up on its own is its own scratch: `.tmp-*`
payloads and `.locks/` files older than an hour, swept once per store instance
on its first publication. Those are crash orphans that nothing else observes.

## The layout on disk

The filesystem store publishes at `<directory>/<first two hex>/<digest>`, with
the directory defaulting to `ArtifactStore.defaultDirectory`, `.flows/objects`.

The two-hex fanout is Bazel's `DiskCacheClient` layout, taken "to bypass
possible folder file count limits". The directory is workspace-relative rather
than absolute so a workspace can be moved or copied whole and still resolve its
own artifacts, and so a sandbox that mounts the workspace inherits them.

Addresses published under the pre-1.0 flat `<directory>/<digest>` layout are
cache misses that re-publish. There is no compatibility shim.

## Prior art

The contract's ergonomics follow Effect's own `KeyValueStore`
(`effect/unstable/persistence/KeyValueStore`): one small set of total
operations over one address space, so a memory, filesystem, or network
implementation is the same shape. `findMissing` is Bazel's
`MissingDigestsFinder`, one batched round trip whose result is guaranteed to be
a subset of its input, because a per-digest existence probe over a network tier
is the wrong shape entirely.

The mechanics come from Bazel's remote-cache classes:

| Taken from                                                                                                                                                                | What                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`disk/DiskCacheClient.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/disk/DiskCacheClient.java)               | The two-hex fanout layout and the fsync of the temp file before the rename               |
| [`http/HttpCacheClient.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/http/HttpCacheClient.java)               | The wire protocol: CAS blobs under `/cas/base16-key`, `PUT` to upload, `GET` to download |
| [`common/MissingDigestsFinder.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/common/MissingDigestsFinder.java) | `findMissing` as one batched probe whose result is a subset of its input                 |
| [`CombinedCache.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/remote/CombinedCache.java)                             | Local first, remote second, write back what the remote returned                          |

Where this package deviates is documented in [The three tiers](/concepts/tiers/).

## Related

- [The three tiers](/concepts/tiers/): how local, shared, and combined stores compose.
- [Coordination between processes](/concepts/coordination/): the locks and fences
  that keep two processes out of each other's way in one objects directory.
- [API reference](/reference/api/): the exact signatures and error shapes.
