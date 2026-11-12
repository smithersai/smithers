---
title: "Inspect a workspace without running target bodies"
description: "List selections, read dependency closures, draw graphs, resolve ownership, and plan targets, with the trust and tool requirements of inspection."
sidebar:
  order: 2
---

`query`, `graph`, `owners`, and `--plan` skip target bodies. Inspection still
evaluates workspace and package declarations as host code, so use it only on
trusted declarations. Planning can also run tools and build declared
environments, as described below.

## List what a pattern selects

```bash
pnpm exec smithers-build query '//packages/...'
```

Each row is a label, the rule behind it, the kinds it participates in, and the
one-line summary its declaration carries. A row for a `Repo.Target` that a
child workspace could not answer for carries a `refusal` instead, so an
unresolvable child is visible rather than silently missing.

This is the first thing to run when a verb reports no targets. If `query` does
not list it, the fault is in discovery or in the pattern, not in the verb. See
[Workspace discovery](../concepts/discovery.md).

## Read a dependency closure

```bash
pnpm exec smithers-build query 'deps(//packages/api:lib)'
pnpm exec smithers-build query 'rdeps(//packages/api:lib)'
```

`deps` prints everything below a target, with its edges. `rdeps` prints every
target that depends on it, transitively, which is the blast radius of a
change.

Both need a single exact or default target. A pattern that resolves to several
is refused, because a closure of many roots answers no question anyone asked.

## Draw the graph

```bash
pnpm exec smithers-build graph '//packages/...'
pnpm exec smithers-build graph '//packages/...' --mermaid > graph.mmd
```

The default is a text tree drawn for a person. `--mermaid` renders a flowchart
and is always returned as data, never drawn to the terminal, because Mermaid
is meant for a file or a renderer.

## Resolve ownership

```bash
pnpm exec smithers-build owners packages/api/src/server.ts
pnpm exec smithers-build owners --diff main
pnpm exec smithers-build query 'owners(//packages/api:lib)'
```

`owners` takes paths and resolves each one to its owners, the reasons those
owners apply, and the agent policy in force. `--diff <base>` adds every path
changed since that git base, both names of a rename and untracked files
included, which is how a review scopes itself to a pull request.

`query 'owners(<label>)'` answers the package-shaped version of the same
question: who owns the package holding that label, plus its upstream packages.

## See what a run would do

```bash
pnpm exec smithers-build ci '//packages/...' --plan
```

The plan names each selected target, whether it is cacheable, and its preview
key. Cache status is unresolved: planned nodes carry placeholder
`cacheLookup: "not-wired"` and `wouldRun: true` values. These are not cache
lookups or rebuild forecasts.

`--plan` skips target bodies, but evaluates trusted declarations and reads the
workspace. It may spawn bounded tool probes for version and identity lookups,
and may resolve or build declared environments such as Nix. For a declared
Nix environment, this includes `nix --version`, `nix build`, and
`nix print-dev-env`; a memoized resolution still needs the version probe.

Planning can write resolution memos under the configured cache directory.
Declarations and spawned tools run on the host and can write outside that
cache, including the Nix store and tool caches. Environment resolution may
fetch dependencies or perform expensive builds. Target write-set confinement
does not make declaration evaluation or these planning tools read-only.

Install the required runtime, package manager, and tools on `PATH`, including
`nix` for a declared Nix environment. Planning may fail or report a refusal
when a required tool or environment is unavailable.

For local cache inspection of one target, use:

```bash
pnpm exec smithers-build explain '//packages/api:lib'
pnpm exec smithers-build show target '//packages/api:lib'
```

Both commands plan the target and inspect its preview key for a matching
successful local result. They report a local `candidate` or `miss`; a candidate
is not a guaranteed hit because execution still validates outputs and
dependency results. The execution key may depend on runtime dependency results,
and the remote cache is not probed.
These commands have the same declaration and tool requirements as planning.
See [Caching](../concepts/caching.md) for what a key covers.

## Read any of it from a program

```bash
pnpm exec smithers-build query 'deps(//packages/api:lib)' --format json
```

An explicit `--format` sends the structured envelope to standard output and
forces the plain renderer on standard error, so the two streams stay separable.
See [Output and renderers](../concepts/output.md).
