---
title: "Quickstart"
description: "Declare a workspace and one target, plan it, run it, watch the second run hit the cache, and query the graph, using only smithers-build."
sidebar:
  order: 2
---

This walks one workspace from nothing to a cached run. It takes about five
minutes and runs one shell target, plus planning tools.

You need Node 26.4.0 or later, git, and a checkout that carries
`@smthrs/build-cli` and `@smthrs/targets` as workspace dependencies. See
[Installation](./installation.md).

## Declare the workspace

Every command starts by finding a workspace declaration. Create
`.smithers/WORKSPACE.ts` at the repository root:

```ts
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({
    manifest: packageJson,
    lockfile: S.file("//pnpm-lock.yaml")
  }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
```

The declaration names the shared facts of the tree: where the cache lives,
which runtime and package manager targets run under, and how `node_modules` is
produced. A root `WORKSPACE.ts` works too; `.smithers/WORKSPACE.ts` is the
form discovery looks for first.

## Declare a target

Create `PACKAGE.ts` beside it. A package exports exactly one
`S.Package({ targets })`, and each key of `targets` becomes a label:

```ts
import { Smithers as S } from "@smthrs/targets"

const greet = S.Shell.Test({ shell: "echo hello" })

export const Package = S.Package({ targets: { greet } })
```

That declares `//:greet`. The empty package path before the colon is the
workspace root; a `PACKAGE.ts` at `apps/site/` would declare
`//apps/site:greet`.

## Look before you run

`--plan` prints the plan and skips target bodies. Read it before running the
target:

```bash
pnpm exec smithers-build test '//:greet' --plan
```

The plan names each selected target, whether it is cacheable, and its preview
key. Cache status is unresolved; planning does not forecast cache hits or
rebuilds. Use `explain` or `show target` for local cache inspection, subject to
the [preview-key limits](./guides/inspect-a-workspace.md#see-what-a-run-would-do).

Planning evaluates trusted declarations and reads the workspace. It may spawn
bounded tool probes for version and identity lookups, and may resolve or build
declared environments such as Nix. It can write resolution memos in the
configured cache; declarations and tools can also write on the host, including
the Nix store and tool caches,
and environment resolution can fetch dependencies or perform expensive builds.
Have the required runtime, package manager, and tools on `PATH`, including
`nix` when declared. See [Planning requirements](./guides/inspect-a-workspace.md#see-what-a-run-would-do).

## Run it

```bash
pnpm exec smithers-build test '//:greet'
```

`echo hello` runs and the target settles green. Run the same command again:

```bash
pnpm exec smithers-build test '//:greet'
```

The second run reports a hit and skips the target body. Planning still runs.
The key covers the target's attributes, its expanded declared inputs, the
result of each dependency, the executor's own implementation, and the host's Node version, platform, and
architecture. Nothing moved, so the recorded result stands. Edit the command
in `PACKAGE.ts` and the key moves with it, and the next run executes again.

To prove a change without trusting the cache, add `--no-cache`. It bypasses
cache reads for that invocation and still publishes what it produces.

## Ask the workspace questions

These queries read the workspace and skip target bodies. They still evaluate
trusted declarations.

```bash
pnpm exec smithers-build query '//...'
pnpm exec smithers-build query 'deps(//:greet)'
pnpm exec smithers-build graph '//...'
```

`query` with a label or pattern lists the selected targets and their kinds.
`deps(<label>)` prints the transitive closure below a target, `rdeps(<label>)`
prints everything above it, and `owners(<label>)` prints the owners the
declarations assign. `graph` prints the same selection as a tree, or as a
Mermaid flowchart with `--mermaid`.

## Run the label without naming a verb

A first argument starting with `//` or `:` is rewritten to the `target`
command, which runs one label under the verb its rule implies:

```bash
pnpm exec smithers-build '//:greet'
```

`S.Shell.Test` is a test rule, so this is `test '//:greet'`. The bare-label
form is how you reach a target whose verb you would otherwise have to
remember, and the only way to run a `review` target without naming the verb.

## Run everything

`ci` plans lint, build, test, and docs over one merged graph and executes it
once, so a target selected by two verbs runs a single time:

```bash
pnpm exec smithers-build ci '//...'
```

`ci` deliberately leaves out `review` and `run`. Both need something a hosted
runner does not have: a model CLI and a credential for one, a decision to
mutate the tree for the other.

## Where to go next

- [Commands](./cli.md): every verb, flag, and exit code.
- [Select the targets a command runs](./guides/select-targets.md): the label
  grammar and what each verb selects.
- [Caching](./concepts/caching.md): what a key covers, and what re-keys a
  target.
- [Target execution](./concepts/execution.md): write-set confinement,
  sandboxing, and the ceilings a run holds to.
