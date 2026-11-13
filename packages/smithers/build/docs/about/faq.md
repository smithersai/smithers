---
title: "FAQ"
description: "Short answers about PACKAGE.ts evaluation, dependency edges, confinement, caching, and which smithers build targets execute today."
---

## Is `PACKAGE.ts` really just TypeScript?

Yes. The CLI imports it through the programmatic `tsx` loader with
`tsconfig: false`. Each module must export `Package = Smithers.Package({ targets })`.
Only `Package.targets` keys become labels. A top-level target export fails with
`naked_target_export`; omitting `Package` fails with `package_export_missing`.
Workspace configuration belongs in `WORKSPACE.ts`. Exporting `PackageDefaults`
does not synthesize targets; see [Default targets](../extending/default-rules.md).

One constraint follows from the loader. `tsconfig: false` means no tsconfig is
read, so compiler options declared in the workspace do not apply: a `paths` alias
does not resolve, and a relative import names the real file, extension included,
as in `import { Package as plan } from "../plan/PACKAGE.ts"`.

## Can a target call read the filesystem?

No. `Target.make` requires a pure plan-time body: it records plan nodes and
executes nothing. `file()`, `glob()`, and `gitDiff()` return inert values. The
planner expands and digests them during discovery. See
[Inputs](../concepts/inputs.md).

## How do I reference another target?

Import it.

```ts
import { Smithers } from "@smthrs/targets"
import { Package as plan } from "../plan/PACKAGE.ts"

const lib = Smithers.TsBuild({ packageManager, deps: [plan.lib] /* ... */ })
export const Package = Smithers.Package({ targets: { lib } })
```

Labels never appear in target attributes. A target value found anywhere inside an
attrs object becomes a dependency edge. See
[Dependencies](../concepts/dependencies.md).

## What are `run` and `docs` for?

`run` selects operational targets that should never be pulled into ordinary
build, test, lint, or CI selection. Examples are cleaning, watch processes,
package scaffolding, and generated-file writes. `NewPackage` receives its name
through `smithers-build run <label> --name <package>`.

`docs` selects documentation targets standalone. The same targets are also part
of `ci`, whose merged graph plans lint, build, test, and docs.

## Which targets actually execute?

The CLI executor supplies implementations for process execution, output
capture, filegroups, generated files, package-manifest synchronization,
workflow and documentation checks, LLM review, package scaffolding, and the
pnpm install actions, including `ExecIrreversibleLive`. `NpmPublish` and
`JsrPublish` have a `run` verb gate and default to `--dry-run`; setting the
resolved attribute `dryRun: false` allows real publication. `Changesets.Version`
executes versioning, while `Changesets.Publish` currently refuses at its
separate outward-action gate. The per-target status is on each page under
[Target catalog](../reference/targets/README.md), and the summary table is in
[Running targets](../workspace/running-targets.md).

## Are actions sandboxed?

Yes. `ExecSandbox` enforces per-target confinement with bubblewrap on Linux,
seatbelt on macOS, or Docker where declared; a host that cannot enforce it
fails the target closed. `sandbox: "none"` or `S.Sandbox.None()` disables it.
Workspace reads are scoped to admitted inputs, dependency outputs, and tool
support paths; writes are scoped to admitted outputs, declared changes, and
private scratch. Networking is closed unless the policy opens it. Native host reads are restricted to enumerated runtime paths and
admitted paths, including explicit external-read grants and declared symlink
destinations. Known home credentials are denied unless explicitly granted.
This is not blanket host-file isolation. Docker exposes declared host mounts
and uses the image's toolchain. See
[Actions and boundaries](../concepts/actions-and-boundaries.md#hermeticity).

## Is `node_modules` cached?

No. `Install` splits into fetch and link, and both use `expected` boundaries.
Fetch populates `.flows/store/<manager>` but is not admitted to a cross-run
engine cache because the current child-process boundary cannot freeze its
lockfile/configuration inputs or prove hermetic reads. Link materializes
`node_modules` locally and always reconciles it. A `node_modules` tree is a
graph of links into a host-local store, so restoring one from another machine
would produce a tree pointing at nothing. See
[Install](../concepts/install.md).

## Why do two targets of one definition need separate runtimes?

A target is a flow tagged by target id. Two `TsBuild` targets share that tag, so
registering both with one engine would alias their bodies. The executor gives
each target a fresh in-memory runtime. Whether that stays the answer is an open
design question.

## Does `--plan` tell me whether a target is cached?

No. Planner output still reports `cacheLookup: "not-wired"` and `wouldRun: true`
for every target. The planner computes the content key but consults no cache. The
executor performs the lookup. See [Caching](../workspace/caching.md).

## Does the cache directory affect cache keys?

No, by design. The resolved cache directory is host state. Discovery never lists
a path inside it, declared globs never expand into it, and its name never reaches
a cache key or a content digest. `DepsLint` writes a generated config under it
using a plan-time token that the exec layer substitutes immediately before spawn.
See [Configuration](../workspace/configuration.md).

## Can I move the package-manager store?

Not through the install Flow. Manager stores stay at `.flows/store/<manager>`
regardless of `cacheDirectory`, because fetch declares that fixed
workspace-relative tree as its write set and a file set names no host path. The
direct `install` command therefore rejects a custom cache directory instead of
declaring one path and writing another. Other target verbs may use a custom
directory. Supporting configurable install stores through the Flow requires the
declaration and host-state substitution to change together.

Budget for the cost. pnpm's own model is one machine-wide store that every
checkout hardlinks from; a workspace-local store gives that up, so each clone
and each worktree downloads and unpacks the whole dependency set again and
keeps its own copy. A CI cache for an install must be sized for the full
workspace store per checkout, and a warm store elsewhere on the machine is not
reused.

A composition that drives `PackageManager` directly, outside the install Flow,
can pass `storeDirectory` to `makePnpm`, `layerPnpm`, or `layerNoop`. It is an
absolute host path outside the project root, used for both `pnpm fetch` and the
offline link, and it restores the shared store. `Install.executeFetch` refuses a
service whose store is not `.flows/store/<manager>`.
