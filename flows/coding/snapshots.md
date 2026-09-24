# Native engine snapshots

The configured coding host supplies the existing `Jj` Effect service through
[`layerAt`](./snapshots.ts). It uses the shared Rust helper's `--engine`
mode and the host's injected process spawner. Node and Bun use this same recipe;
there is no sidecar, new snapshot database, or second identity service.

The engine's `snapshot().commitId` is a **full immutable JJ commit ID**.
`snapshot().changeId` retains the stable identity of the planned atom.
The helper captures with
`jj status`, never `jj new` or `jj describe`. Action labels and attempt metadata
stay in the existing flow journal. Both compensable action preimages and the
engine's settled diff snapshots therefore preserve the planned atom.

```ts
import * as Snapshots from "./snapshots.ts"

const snapshots = Snapshots.layerAt({ repositoryPath: workspaceRoot })
  .pipe(Layer.provide(containedHostSpawner))
```

This is private application composition, not a new public API. The caller owns
`containedHostSpawner`, its durable process ledger, and its scope. The layer
uses literal argv and bounded process output; cancellation closes the acquired
process scope. Remaining `Jj` methods delegate to the existing repository-bound
spawner adapter. Production uses the fixed Plue provisioning configuration;
adapter paths can only be supplied by trusted host construction.

A restore requires the current native change ID and exact parents to match the
captured preimage. The guest saves pending bytes, checks ownership again, pins
both immutable operands, restores the tree, and verifies the description,
parents, change identity, and resulting tree. It refuses to redirect a restore
into a different atom. Diffs read exact historical objects without snapshotting
the working copy. Short refs, mutable change IDs and old NodeJj short snapshot
handles are refused; existing runs carrying those handles require inspection,
not automatic conversion to the current version of that change.

JJ trees cover tracked repository content. A successful `jj status` can still
omit nonignored files when native tracking or size limits exclude them; the
guest explicitly refuses that incomplete capture. Ignored paths are outside the
snapshot tree and must be rejected by the configured host before a compensable
file mutation. This layer alone is not a guarantee that arbitrary ignored files
or shell effects can be rolled back. Shell actions retain their own declared
effect tier. No tree walker or alternate file ledger is hidden here.

The real native test runs under both NodeServices and BunServices and verifies
preserved atom ownership, exact later/reopened restoration, new-file removal,
read-only historical diffs, invalid/foreign references, and incomplete native
snapshot refusal. The configured-host acceptance additionally drives the
production guarded agent `write` through QuickJS and the durable engine.
