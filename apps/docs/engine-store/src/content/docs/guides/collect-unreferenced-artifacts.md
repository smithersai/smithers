---
title: "Collect unreferenced artifacts"
description: "Run an explicit mark and sweep over the artifact store: the live roots, the grace bound, pinned digests, and why the collection is fail-safe rather than best-effort."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/guides/collect-unreferenced-artifacts.md"
---

Boundary evidence spills large outputs to the artifact store by digest. When
the attempt rows and cache entries that referenced those blobs are deleted, the
blobs stay. `ArtifactGc` is the explicit pass that removes them.

Collection never runs automatically. `gc()` is a verb a caller invokes, and
[`smthrs gc`](https://smithers.sh/docs/reference/cli/gc/) invokes it after its retention pass.

## Run a collection

```ts
import { ArtifactGc } from "@smthrs/engine-store"
import * as Effect from "effect/Effect"

const sweep = Effect.gen(function*() {
  const gc = yield* ArtifactGc.ArtifactGc
  return yield* gc.gc({ dryRun: true })
})
```

`ArtifactGc.layer(options?)` provides the service and needs `SqlClient` and
[`@smthrs/artifacts`](https://artifacts.smithers.sh/reference/api/)'s `ArtifactSweep`.
`ArtifactGc.layerFileSystem(options?)` provides the filesystem sweep too and
needs `SqlClient` and `FileSystem`; give it the same `directory` and
`coordination` as the `ArtifactStore.layerFileSystem` it collects behind.
`MakeOptions.pageSize` sets how many rows one mark-phase page holds; it defaults
to 500.

`GcOptions` takes `graceMs`, `pins`, and `dryRun`. A `GcReport` comes back with
`scannedBlobs`, `liveDigests`, the `sweptDigests` list, `reclaimedBytes`,
`keptByGrace`, and the `dryRun` flag.

## Set the grace bound

`graceMs` is how recently a blob must have been written or freshened to survive
being unreferenced. It defaults to the installed policy's bound, then to
`ArtifactGc.defaultGraceMs`, which is 14 days, git's `gc.pruneExpire` default.

Each collection reads its start time before resolving policy pins or scanning
roots. The cutoff is `startTimeMs - graceMs` and stays fixed through inventory
and deletion. Only mtimes strictly before the cutoff are eligible; equality
is retained, including publications in the starting millisecond with zero
grace. The remove-side mtime fence uses the same cutoff, so a slow scan cannot
age a concurrent publication into eligibility.

The bound is deliberately far beyond any live attempt's duration. A blob spilled
by a running step is unreferenced until its attempt row finishes, and the grace
period is the only thing protecting it in that window.

## Install a policy

`ArtifactGcPolicy` carries the defaults a `gc()` call may omit. Explicit
`GcOptions` override the policy, and the policy overrides the built-in
defaults:

```ts
const policy = ArtifactGc.layerPolicy({
  graceMs: 7 * 24 * 60 * 60 * 1000,
  pins: Effect.succeed([pinnedExportDigest])
})
```

`pins` is the seam for references this composition's tables cannot see: an
external index, or an export a human wants kept. Each entry is a hex SHA-256
content address. It is an effect, resolved fresh on every collection, and its
digests are held live regardless of reachability.
Installing a policy configures collection; it never schedules it.

## What counts as a live root

The mark phase reads this package's own tables directly, because the package
composes every one of those migrations:

- Every row of `flows_step_cache`, through its boundary evidence.
- Every row of `flows_attempts`, through its boundary evidence and its
  checkpoints. Digest-shaped strings in a checkpoint are retained
  conservatively.
- The pins.

Every run present in `flows_runs` is a live root: there is no deleted state, and
the attempt table's foreign key guarantees each attempt's run exists, so the
scan is all attempt rows plus all cache entries, paged by primary key.

## The mark is fail-safe, not best-effort

A root row carrying boundary evidence this build cannot decode aborts the
collection with `mark_failed` rather than contributing nothing. Silently reading
such a row as "references no artifacts" is exactly how a live blob gets
collected. A metadata shape with no `boundary` key at all is the ordinary
foreign-evidence case, and yields the empty set.

## Why concurrent work is safe

The live set is computed before the inventory, so a root recorded during the
sweep can only be missed, never half seen. The blob such a root references is
protected anyway: a fresh publication carries a fresh mtime, a re-publication of
existing bytes freshens the blob's mtime, and the sweep's deletion is fenced on
that mtime. A crash mid-sweep deletes some garbage and no live blobs, and
re-running converges.

## Read the failures

`ArtifactGcError` carries one of three codes:

| Code              | Meaning                                                                                |
| ----------------- | -------------------------------------------------------------------------------------- |
| `invalid_options` | An option was outside its admissible range.                                            |
| `mark_failed`     | A root could not be scanned or its evidence could not be decoded. Nothing was deleted. |
| `sweep_failed`    | The inventory or a deletion refused.                                                   |

## Order it after retention

Deleting run history removes roots; collecting artifacts removes the blobs
those roots kept alive. Run
[retention](/guides/delete-old-run-history/) first, then this pass, or the blobs
freed by retention wait for the next collection.

A backup taken while a collection runs would race the sweep. `DisasterRecovery`
takes the artifact backup lease for the whole capture when it is given an
`objectsDirectory`, so a concurrent sweep cannot delete a blob between the
database snapshot and its copy. See
[Back up and restore the store](/guides/back-up-and-restore/).
