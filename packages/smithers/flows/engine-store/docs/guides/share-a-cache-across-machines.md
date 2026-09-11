---
title: "Share a step cache across machines"
description: "Wire ArtifactSync and CacheSync onto a shared tier so one machine's sealed result serves another, and choose how eagerly a replay downloads the artifacts it references."
sidebar:
  order: 4
---

By default a recorded step result is local. Two seams turn it into a shared one:
`ArtifactSync` publishes the blobs the result references, and `CacheSync`
publishes the result entry itself. Both are absent by default, which is what
keeps a purely local engine free of any remote-cache machinery.

## Trust every writer of the shared tier

A shared step-result tier is trusted to write into your workspace. A hit
replays the entry's boundary evidence through `StepBoundary.replayOutputs`: it
writes each recorded output, deletes each path recorded with `digest: null`,
and prunes files under a recorded tree that the entry does not list. The
integrity checks are self-consistent, not authenticating: inline bytes are
checked against the digest recorded in the same entry, and blobs against their
own address. Replay refuses paths outside the workspace, but inside it an entry
chooses both the path and the content that lands on every machine that hits it.

Only producers you trust as much as your own machines may write to the tier.
This is the trust model of Bazel's remote cache.

- Give consumers read-only credentials, and grant write access only to the
  machines whose results you would run anyway, such as CI.
- Use a separate tier per tenant or trust level rather than one tier shared
  across them.

A stronger property, accepting entries only from named producers, needs signed
provenance on the entry. Another digest check cannot provide it.

## Publish artifacts before entries

Provide `ArtifactSync` with a shared `ArtifactStore`. The two tiers cannot both
be layers, because they inhabit the same tag and composing both would shadow
one, so the shared tier arrives as an effect:

```ts
import { ArtifactSync } from "@smthrs/engine-store"

const artifacts = ArtifactSync.layer(remoteArtifactStore, { downloadPolicy: "all" })
```

`layer` takes the local tier from the `ArtifactStore` tag and the shared tier
from the effect. `ArtifactSync.make({ local, remote, downloadPolicy })` is the
same thing without the layer.

`publish(digests)` runs `findMissing` on the shared tier, uploads what is
missing, and re-probes to confirm. It is called immediately before the
transaction that records the cache entry, and never inside it. A publication
that cannot make the artifacts durable fails with `ArtifactPublicationFailed`
and the shared entry is withheld.

## Publish entries after they are durable

```ts
import { CacheSync } from "@smthrs/engine-store"

const entries = CacheSync.layer(remoteCacheStore)
```

`publishEntry(entry)` reports a refusal rather than failing: `Option.none()`
means the entry is now shared, and `Option.some(error)` means it is not, and
why. A `Conflict` from the shared tier is not reported at all, because it means
another machine recorded the key first, which is exactly the first-writer-wins
outcome a shared tier exists to arbitrate.

Compose it with `CombinedCacheStore` in `"deferred"` publication mode, which is
the mode that leaves the shared write to this seam. Lookups stay read-through
either way.

## Neither seam can fail a run

Both run after `attempts.finish`, so the result is already durably recorded on
this host. A refusal withholds the shared copy, never the local row, and
journals a `cache-provenance` record with `action: "unpublished"` carrying the
stage (`artifacts` or `entry`) and the reason. A missing shared entry is
therefore explainable from the journal rather than inferred from its absence.

## Choose a download policy

`hydrate(digests)` establishes that this host can resolve every referenced
artifact and reports whether the replay is now worth retrying. It never fails a
run: a shared tier that is down must not stop work that can simply be done.

How eagerly it materializes is `downloadPolicy`. Declare it once on the shared
tier as `RemoteArtifacts.Options.downloadPolicy` and both seams read it; pass it
explicitly to `make` or `layer` to override.

| Policy          | Choose it when                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `all` (default) | You want every later read to be local and want a shared tier outage after admission to cost nothing.     |
| `toplevel`      | You read a small subset of a large output set and compose `CombinedArtifacts` over the same remote tier. |
| `minimal`       | The same, and you do not want this host accumulating other machines' artifacts.                          |

The two lazy policies are sound only when the store the replay reads through can
reach the shared tier, which means `CombinedArtifacts` with the same remote
tier. Under a purely local `ArtifactStore` an admitted lazy replay would later
read an artifact this host never fetched.

## Fall back to local explicitly

`ArtifactSync.layerLocal` and `CacheSync.layerLocal` are the single-tier
implementations: publish is a no-op and hydrate reports nothing arrived. They
are what the engine falls back to when the tags are absent, and providing them
explicitly says "this composition is local on purpose".

## Make sure the results are shareable at all

Publishing does nothing for a result that was never admitted to the cache. A
record is admitted only when the action is sealed, the boundary is hard, no
deviation occurred, and the evidence carries `wholeTreeWritesVerified: true`.
Under the production composition that flag comes from
`WorkspaceSandbox.layerFileSystem()`, so a composition with `StepBoundary.layer`
and no sandbox produces run-local results however the sync seams are wired. See
[Cache admission](../concepts/cache-admission.md).

## What a replay does when the bytes are missing

A verified hit calls `replayOutputs` before returning the stored result. When
that refuses with `MissingArtifact`, the normal first answer for a row recorded
on a machine whose artifacts this one has never seen, the dispatch hydrates from
the shared tier and retries the replay exactly once before falling through to a
real execution.

## Related

- [Cache admission](../concepts/cache-admission.md): the ordering argument and
  the verification that runs before a hit is served.
- [Artifacts and the cache](/docs/guides/artifacts-cache/) on smithers.sh: the
  operator-facing version.
