---
title: "Back up and restore the store"
description: "Take a hot backup of a live engine database and its artifact blobs, verify it, restore it into a fresh directory, and fence the restored file so no pre-backup owner resurrects."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/guides/back-up-and-restore.md"
---

`DisasterRecovery` captures a live store without stopping it, verifies a capture
against its own manifest, restores one into a fresh directory, and invalidates
the ownership fences the restored file still carries.

Back up the authoritative stores even when using the additive
[typed event contracts](https://journal.smithers.sh/concepts/state-event-authority/).
The demonstrated attempt projection rebuilds disclosed history, including from
a retained snapshot and suffix. It does not recover arbitrary private results,
all execution state, or live ownership fences. Current writers and retained
history keep their existing bytes until an explicit writer cutover and migration.

## Start from the reference script

A reference command-line entry point,
[`flows-backup.mjs`](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/engine-store/scripts/flows-backup.mjs),
is the operator front end these three operations were designed against. It is
not part of the published package, because the host layers are yours to choose:
copy it into your own project, or read the sections that follow and compose the
operations directly. It parses arguments and composes the Node host layers, and
nothing else. Once copied, it takes three commands:

```bash
node flows-backup.mjs backup <database-file> <backup-directory> [objects-directory] [--max-file-size <bytes>]
node flows-backup.mjs verify <backup-directory> [--max-file-size <bytes>]
node flows-backup.mjs restore <backup-directory> <target-directory> [--max-file-size <bytes>]
```

`--max-file-size` sets `maxFileSizeBytes`, described below. Raise it when the
database file or a blob is larger than 512 MiB.

Its `restore` command calls `restoreAndFence`, so the restored file is fenced
before the command returns.

## Take a backup

```ts
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { DisasterRecovery } from "@smthrs/engine-store"

const capture = DisasterRecovery.backup({
  directory: "./backups/2026-09-03",
  objectsDirectory: "./.flows/objects",
  snapshotDatabaseLayer: (databaseFile) => NodeDatabase.layer({ filename: databaseFile })
})
```

The database is snapshotted first with `VACUUM INTO`, a read transaction under
WAL, so live writers are never blocked and the copy is one consistent point in
time. The artifact walk runs after it, so every digest the snapshot references
is captured, because publication always precedes reference. Blobs are
digest-verified as they are copied: a blob whose bytes no longer hash to its
address fails the backup loudly rather than capturing corruption. The manifest
is written last, so a partial backup is detectable by its absence. A failed
backup removes what it wrote, so you can retry into the same directory.

`snapshotDatabaseLayer` opens the frozen file so the backup can enumerate
artifact roots and migrations from that exact snapshot, independently of the
live connection. Open it without applying migrations.

**Pass `objectsDirectory` whenever the composition has a filesystem artifact
tier.** With it, the whole capture holds the cross-process artifact backup
lease, so a concurrent `ArtifactGc.gc` sweep cannot delete a blob between the
database snapshot and its copy. Without it, no lease is taken, the backup
carries no blobs, and a snapshot that references any artifact digest fails with
`snapshot_incomplete` rather than reporting success. Pass the same directory you
give `ArtifactStore.layerFileSystem`.

`FileSizeOptions.maxFileSizeBytes` bounds what backup, verify, and restore may
buffer for hashing or copying. It defaults to
`DisasterRecovery.defaultMaxFileSizeBytes`, which is 512 MiB. An oversized file
fails with the typed `io` code instead of reaching the host's allocation limit.
Each file is read whole into memory, so set the limit above your largest
database or blob and below the memory the host can spare.

## Verify a backup without restoring it

```ts
const check = DisasterRecovery.verify("./backups/2026-09-03")
```

The manifest decodes, the database snapshot hashes to its recorded digest, and
every listed artifact blob is present and hashes to its address. Run it on a
schedule against your backup storage; a backup you have never read is a
hypothesis.

## Restore and fence

```ts
import { DurableWriter } from "@smthrs/database"
import * as Layer from "effect/Layer"

const restored = DisasterRecovery.restoreAndFence({
  backupDirectory: "./backups/2026-09-03",
  targetDirectory: "./.flows-restored",
  databaseLayer: (databaseFile) =>
    Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: databaseFile }))
})
```

Every byte is re-verified against the manifest as it is copied, so a backup that
rotted in storage is refused rather than restored. The target holds the database
file (`store.sqlite3`), an `objects` directory, and a `restored.json` marker, and
is a fresh store directory to compose `NodeDatabase.layer` and
`ArtifactStore.layerFileSystem` over.

`restore` alone leaves the pre-backup owner fences in place. Run
`DisasterRecovery.fence(manifest)` against the restored file before any engine
adopts it, or use `restoreAndFence`, which does both and returns a
`FencedRestoredStore`.

## What fencing does

The store's fence is `OwnerId` equality, so fence invalidation is the epoch
bump. In one serialized write transaction, every pending claim is cleared and
every run that was `running` at backup time is suspended with its owner and
heartbeat cleared. A surviving pre-backup owner then fails every fenced
operation against the restored store: `heartbeat` and `transitionOwned` report
`FenceLost`, and fenced journal appends fail `fence_lost`. The suspended runs
are claimable immediately, without waiting out the heartbeat staleness cutoff
and without liveness evidence.

`FenceSummary` reports `clearedClaims` and `suspendedRuns`.

Fencing requires every migration recorded in the manifest to remain applied
with the same ID and namespaced name. A missing or renamed historical entry
fails with `schema_mismatch` before ownership is cleared. Forward additions in
any installed block are compatible, including engine-store `3006` below an
existing plan `4003`. The current database layer applies migrations on open;
the manifest need not be a prefix of the globally ordered migration list.

In-flight attempt rows are deliberately untouched: attempt writes are fenced on
the run row's ownership, and the resuming engine adopts or retries them under
its own fresh owner.

## Failure codes

`DisasterRecoveryError` carries a stable `code` and the `method` that raised it:

| Code                  | Meaning                                                       |
| --------------------- | ------------------------------------------------------------- |
| `invalid_options`     | An option cannot be admitted safely.                          |
| `not_empty`           | A target or backup directory exists and is not empty.         |
| `invalid_manifest`    | The manifest is missing or does not decode.                   |
| `missing_file`        | A file the manifest lists is absent.                          |
| `digest_mismatch`     | The database snapshot does not hash to its recorded digest.   |
| `artifact_corruption` | A blob does not hash to its address.                          |
| `snapshot_incomplete` | The snapshot references artifacts the capture could not take. |
| `schema_mismatch`     | A recorded migration is missing or has a different name.      |
| `io`                  | A host read or write refused, including an oversized file.    |
| `sql`                 | The database refused; the dialect here is SQLite.             |

## Related

- [Ownership and fencing](/concepts/ownership-and-fencing/): why a restored
  file needs a fence at all.
- [Collect unreferenced artifacts](/guides/collect-unreferenced-artifacts/): the
  sweep the backup lease fences against.
