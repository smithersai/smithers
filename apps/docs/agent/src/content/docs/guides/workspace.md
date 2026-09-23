---
title: "Isolate and observe a run's workspace"
description: "Run cell calls inside a workspace transaction with sandboxed, measure mutation with WorkspaceObservation, and pin trees for Checkpointed calls."
sidebar:
  order: 8
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/guides/workspace.md"
---

Three independent host concerns share one subject, the workspace a run touches:

- `FlowEngineLike.sandboxed` runs every cell call inside an outer workspace
  transaction.
- `WorkspaceObservation` measures the tree around a frame, so "did this frame
  change anything" is a fact rather than a claim.
- `Checkpointed` points one call at a pinned tree instead of the live one.

Each composes by itself; a host that wants none of them composes nothing.

## Check declarations with sandboxed

```ts
import { FlowEngineLike } from "@smthrs/agent"

const calls = yield* FlowEngineLike.sandboxed(sandbox, runner)
```

Two properties are the point:

- **A declaration is checked, not trusted.** A call that reads or writes
  outside what the cell chose comes back `Invalidated`, and the adapter turns
  that into a catchable call failure the cell can read: "Flow X touched what it
  did not declare; its changes were discarded." The speculative changes are
  discarded with it.
- **Materialization is explicit.** The sandbox admits a result before any host
  state moves, so a conflicting concurrent write is a typed refusal instead of
  a lost update.

`sandboxed` is a `CallRunner` decorator rather than an option on
`FlowEngineLike.make`, so it composes with whatever else the host has wrapped
its calls in, `Checkpointed` included. The `WorkspaceSandbox` contract itself
belongs to [`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/);
`InMemoryWorkspaceSandbox.make` creates the deterministic in-memory
implementation a test or conformance suite uses.

## Measure mutation with WorkspaceObservation

A shell command declares nothing and writes wherever it likes, so the loop
cannot learn "this frame changed the tree" from declarations. Provide an
`Observer` and the engine port measures instead:

```ts
import { WorkspaceObservation } from "@smthrs/agent"

const observer = WorkspaceObservation.layer("/path/to/workspace")
```

The measurement is a pruned walk that folds every kept file's path, size, and
modification time into one digest: identity, not content, because reading every
byte costs the whole tree twice per frame. The walk prunes derived artifacts
(`defaultPrune` and `defaultIgnoreSuffixes`, both replaceable through options),
skips symlinks whole, treats a vanished path as movement rather than an error,
and reports `complete: false` when it stops at `maxPaths` (default 50,000) or
cannot list a directory or stat an entry. Missing paths (`NotFound`, including
`ENOENT`) are omitted without making the walk partial. Other listing and stat
failures emit warning diagnostics with the failed operation, path, and cause.
For a partial walk, the controller decides changed-ness from what the frame's
calls declared.

Three rules govern the layer:

- Hand it the host's own `FileSystem`, not the kernel-guarded one. The walk is
  stat-only, never follows a symlink, and every path it builds starts from the
  root it was constructed with, so the guard has nothing to decide; guarding it
  bills one helper process per file, twice per frame.
- On Node, prefer `NodeControl.layerObserver(root)`. It runs the same walk on
  a host that makes one call per file instead of two, measured together.
- A composition that provides no observer answers unobserved, and the loop
  falls back to declarations. `WorkspaceObservation.layerNoop` is the opposite
  case, an observer that fails on purpose so a host can prove the failing path.

## Pin trees with Checkpointed

`@smthrs/harness` decides whether a call may name a checkpoint: it mints the
handle, bounds how many a run may hold, and folds the checkpoint into the call's
key, so a reading of the pinned tree can never replay as a reading of the live
one. `Checkpointed.decorate` is the other half:

```ts
import { Checkpointed } from "@smthrs/agent"

const calls = yield* Checkpointed.decorate(runner)
```

With a `Checkpoints` store in context, a call carrying an `at` runs against the
pinned tree checked out as a directory, and the directory is given back when
the call ends. Without one, the runner is wrapped in `Checkpointed.unpinned`,
which refuses every `at`-carrying call with `checkpoint_unavailable`: a call
that names a tree must never quietly read the live tree instead, because a
fails-before proof built on that reading would be a proof of nothing.

The relocation refusals are catchable call failures with remedies in their
messages: a flow that names what it touches rather than where it runs
(`unsupported`), an absolute path (`absolute`), and a path that climbs out of
the checkpoint with `..` (`outside`), which is the live tree under another
name.

One limit is stated plainly: a checkpoint is where a call runs, not a sandbox.
A shell command that names an absolute path inside its command text may still
write anywhere the run can write. Confinement is `WorkspaceSandbox`'s job, and
the two compose independently.
