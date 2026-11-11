---
title: "Step boundaries"
description: "The declared read and write sets of a step, what prepare, settle, and replayOutputs each measure, and why only whole-tree evidence may enter the shared cache."
sidebar:
  order: 3
---

A step declares which files it reads and which it writes. `StepBoundary` is the
service that measures that declaration against reality: before the step runs,
after it runs, and again when a later replay has to reproduce its outputs on a
workspace that never executed anything.

The declaration itself is `FileBoundary`, from
[`@smthrs/flow`](/api/flow)'s `Action` namespace: a `readSet`, a `writeSet`,
optional `removes`, and a `boundaryMode` of `hard` or `expected`.

## The three calls

```ts
interface Service {
  readonly prepare: (descriptor: FileBoundary) => Effect<PreparedBoundary, UnsupportedBoundary, Crypto>
  readonly settle: (prepared: PreparedBoundary) => Effect<BoundaryEvidence, SettleError, Crypto>
  readonly replayOutputs: (evidence: BoundaryEvidence, options?: ReplayOptions) => Effect<void, ReplayError, Crypto>
}
```

`prepare` measures the declared read set's real digests and returns a
`PreparedBoundary` carrying the descriptor plus a `readSnapshot`. The declared
digests in the descriptor are caller metadata folded into the step key; the
snapshot is the evidence that they still describe reality.

`settle` measures the writes afterwards and turns them into
`BoundaryEvidence`: the declared outputs (as a replayable payload), a
`diffIdentity` naming the post-state, and two optional honest flags,
`wholeTreeWritesVerified` and `hermeticReadsVerified`.

`replayOutputs` reproduces those outputs from the evidence. By default it
reproduces the whole recorded post-state: it overwrites a recorded output whose
content differs, removes each recorded removal, and prunes unrecorded files
under a recorded tree. A cache hit replays this way, because the workspace
never ran the step. With `{ restore: "missing" }` it writes a recorded output
only where the path is absent and removes nothing. A wake that replays an
attempt its own run already settled uses that mode, so it never undoes what a
later step or a person did to those paths.

## Hard mode refuses, expected mode records

The same observation produces a refusal in `hard` mode and a `BoundaryDeviation`
in `expected` mode:

| Observation                                                            | Hard mode                  | Expected mode                        |
| ---------------------------------------------------------------------- | -------------------------- | ------------------------------------ |
| Wrote outside the declared write set                                   | `UndeclaredWrite`          | `ExpectedSetDeviation`               |
| Did not produce a declared output, and did not declare it as a removal | `MissingDeclaredOutput`    | `MissingDeclaredOutput` deviation    |
| Left a declared removal in place                                       | `SurvivingDeclaredRemoval` | `SurvivingDeclaredRemoval` deviation |

Under `EngineStore`, a hard-mode refusal settles the action as a defect that
carries the refusal's tag, code and paths. It never passes through the action's
`error` schema; see
[Troubleshooting](../troubleshooting.md#a-boundary-refusal-in-a-flow-run).

The two absence cases exist for a specific reason. Recording `digest: null` as
valid evidence caches the claim "this file should not exist", which
`replayOutputs` then acts on by deleting the path on a workspace that never ran
the step. A step that crashed after declaring its writes would poison the cache
with an eraser. Declaring a path in `removes` is how a deliberate deletion says
so, and it is the only thing that makes an absence legitimate.

A deviation of any variant bars the evidence from the shared cache, so an
unexplained absence never reaches another host either way. Deviations go to
[`Reconciliation`](../guides/drive-a-plan.md), which answers with a verdict.

## Bounded host measurement

`prepare` and `settle` use the kernel's optional guarded batch capability when
the host provides it. Enumeration batches directory and stat requests while
retaining the plan's glob matcher, dotfile behavior, pruning, sorted output,
and entry budget. Hosts without batching use the existing operations with at
most four in flight.

Read digests are SHA-256 of the original file bytes. Tree-artifact and diff
identities still use the same canonical key inputs and absence sentinels, so
batching introduces no persisted key or evidence migration. The declaration
snapshot stays immutable, and all measurements use the same guarded filesystem
whose root descriptor identity is pinned at composition.

Settlement first obtains digest/size measurements, then groups content reads
by both path count and the host's response-byte budget. A change between the
two measurements refuses settlement. Inline decisions and artifact spills
remain in sorted path order, preserving the aggregate inline budget and the
resulting manifest. Helper errors retain their original cause through
`UnsupportedBoundary`. Losing the workspace root fails the boundary instead
of turning every file into an absence.

Batching does not freeze the workspace, attest whole-tree writes, or change
cache admission. Each helper measures through checked descriptors; later
verification still has to consume fresh measurements through that boundary.

## Inline, or spilled by digest

Outputs are recorded by content digest, never inlined without bound. Two limits
on `FileSystemOptions` decide:

- `maxInlineBytes`, the largest single output carried inline in the evidence.
  Defaults to 1 MiB.
- `maxTotalInlineBytes`, the largest aggregate inline payload one settle may
  fold into its evidence. Defaults to 8 MiB. A per-output bound alone still let
  a wide write set multiply many individually small payloads into an unbounded
  evidence row.

Anything past either bound is handed to the `ArtifactStore` and recorded by
digest reference only. `referencedDigests(evidence)` names exactly those
digests: the set a shared tier must hold before the evidence's cache entry
becomes observable there, and the set a replay on a fresh host has to fetch.

The blob mechanics, content addressing, atomic publication, digest
verification, and dedupe, belong to [`@smthrs/artifacts`](/api/artifacts). What
stays here is the policy that decides which outputs become blobs at all.

## Why the production boundary cannot claim the whole tree by itself

`StepBoundary.layer` is the filesystem-backed boundary over the kernel
`FileSystem` seam and the artifact store. It measures declared paths. It cannot
see a write elsewhere in the tree, so it never claims
`wholeTreeWritesVerified` on its own, and a composition with a boundary but no
sandbox keeps the honest outcome: run-local results only.

The whole-tree proof comes from running the body somewhere else. That is
[`WorkspaceSandbox`](./workspace-transactions.md): the transaction is the tree,
so a write outside the declared set is a map comparison rather than an
inference, and the engine sets the flag structurally.

`StepBoundary.layerTest(options)` is deterministic and supports
explicit `failure` or `deviation` fixtures, replay, and `readSnapshot` assertions, but it does not
enforce a real sandbox. Its `wholeTreeWriteDetection` default of `true` is a
fixture, not a proof.

## Replay refusals a caller can act on

`replayOutputs` distinguishes three failures on purpose:

- `MissingArtifact`: the bytes are simply not on this host. A shared artifact
  tier can repair it, so `ArtifactSync.hydrate` fetches and the dispatch
  retries the replay exactly once before falling through to a real execution.
- `BoundaryCorruption`: the bytes are here and no longer hash to their recorded
  digest. That is an integrity violation, not a transient failure.
- `UnsupportedBoundary`: the host could not honour the boundary at all. It is
  the catch-all, and it carries the refusing host or store failure whole in
  `cause` rather than flattened into the message.

## Related

- [Workspace transactions](./workspace-transactions.md): where the whole-tree
  proof actually comes from.
- [Cache admission](./cache-admission.md): the full list of conditions a record
  must meet before another run may use it.
- [Share a cache across machines](../guides/share-a-cache-across-machines.md):
  publishing the digests this evidence references.

Test filesystem classification with `StepBoundary.layer` over an in-memory `FileSystem` and `ArtifactStore`. `layerTest` returns supplied settlement evidence or failure verbatim; it does not classify changed paths, missing outputs, or surviving removals.
