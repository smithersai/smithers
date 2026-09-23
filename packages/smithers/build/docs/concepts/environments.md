---
title: "Environments"
description: "Declaring the Nix closure that tool-running targets resolve their executables from, and what putting a toolchain in the key makes cacheable."
---

Where do the tools a target runs come from? Without an environment declaration,
from whatever the host has on `PATH`. A workspace declares its Node version and
its package manager, and the CLI refuses to run when the host does not satisfy
them, but the executable that actually runs is still the host's. That is why
almost every external-tool target is non-cacheable: the compiler that produced a
result is not in the result's key.

A Nix environment closes that gap. The workspace declares the closure its tools
come from, once, the way it declares a runtime and a `node_modules` tree, and
every tool-running target resolves executables from that closure and is keyed
on it.

## Declaring one

The flake form names `flake.nix`. The lock beside it is declared with it, so
an edit to either re-keys everything that runs under the environment.

```ts
// PACKAGE.ts
import { Smithers } from "@smthrs/targets"

export const environment = Smithers.Nix.Environment({
  flake: Smithers.file("//flake.nix")
})
```

The file form names a plain Nix expression that evaluates to one derivation,
such as a `pkgs.mkShell` or a `pkgs.buildEnv`:

```ts
export const environment = Smithers.Nix.Environment({
  file: Smithers.file("//.smithers/environment.nix")
})
```

A flake form may name the dev shell to enter. A bare name resolves to
`devShells.<system>.<name>` for the host system; a dotted path is used as
written.

```ts
Smithers.Nix.Environment({ flake: Smithers.file("//flake.nix"), attr: "ci" })
```

On the routed surface the same declaration is a `Workspace` option, beside the
runtime and the installed modules, or an entry in `toolchains`:

```ts
// WORKSPACE.ts
export const Workspace = S.Workspace("force", {
  repository: "git+https://github.com/artsy/force.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ manifest: S.file("//package.json") }),
  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  environment: S.Nix.Environment({ flake: S.file("//flake.nix") })
})
```

A `toolchains` entry declared with `S.Nix.DevShell` is not an environment. It
pins the tools `S.Nix.bin` references name and nothing else, so a Go workspace
that lists a dev shell beside its Go toolchain keeps resolving `go` the way it
declared.

## Which targets it applies to

A `PACKAGE.ts` export applies to its own package and every package below it. The
root `PACKAGE.ts` therefore declares the workspace environment, and a package
that exports its own `Smithers.Nix.Environment` overrides it for that package
alone. A `PACKAGE.ts` exports at most one; two is an error.

`graph` and `query` describe the tree without running anything, so they never
need `nix` on the host. Every executing verb resolves the declared environment
before planning the first target.

## Resolution

The planner resolves each declaration once per run:

1. `nix` is looked up on the host `PATH`. A host without it fails the command
   with `nix_absent`. There is no fallback to host tools: a declared
   environment is a statement about where every tool comes from, and running
   the host's copy instead would be a silent lie in the key.
2. The declared inputs are digested. A flake without its lock fails with
   `nix_input_missing`; run `nix flake lock` and commit the lock.
3. `nix build --no-link --print-out-paths` realizes the dev shell or the
   expression and reports its store path. The 32-character store hash names
   the closure everywhere below.
4. `nix print-dev-env --json` reports the shell's exported variables. `PATH`
   becomes the whole `PATH` every tool spawns with. A few other variables
   travel with it, the ones that tell a closure's `curl`, `git`, and libc
   where the certificate bundle, the locale archive, and the time zone
   database live: `SSL_CERT_FILE`, `NIX_SSL_CERT_FILE`, `GIT_SSL_CAINFO`,
   `LOCALE_ARCHIVE`, `TZDIR`, `NIX_LD`, `NIX_LD_LIBRARY_PATH`.
5. `nix path-info --recursive` lists the transitive closure.

The result is memoized under `<cacheDirectory>/nix/`, keyed on the input
digests, the host system, and the `nix` version, and reused while the store
path still exists. A second run in an unchanged tree skips evaluation.

## What changes for a target

**Tool resolution.** `ExecLive` spawns with the closure's `PATH` in place of
the host's. `pnpm`, `node`, `tsc`, `vitest`, `cargo`: all of them resolve from
the closure, and a tool the closure lacks is absent rather than found on the
host by accident. The install flow's package manager and runtime layers look
executables up in the same `PATH`.

**Version assertions.** A declared `Runtime.Node({ version: ">=26.4.0" })` and
a declared `PackageManager.Pnpm({ version: "11.21.0" })` become assertions
against the closure. The planner probes each declared tool once per closure
and fails the plan with `nix_version_mismatch`, naming both the declared
requirement and what the closure provides, before any target runs.

**Key material.** Every target that spawns a process under the environment
gets `nix:<store hash>` in its `layers`. Editing the flake, its lock, or the
expression changes the hash and re-keys every such target, transitively. A
target whose capabilities exclude spawning, such as `PnpmWorkspace`,
`Tsconfig`, or `Clean`, is not keyed on the closure; re-doing an in-process
file write because a compiler changed would be work for nothing.

**Cacheability.** The external-tool targets that were non-cacheable for want of
toolchain identity become cacheable under a declared environment: `TsBuild`,
`DtsBuild`, `Typecheck`, `Vitest`, `VitestCoverage`, `NodeTest`, `EsLint`,
`BiomeCheck`, `DepsLint`, `PackageLint`, `CargoTest`, and `CargoLint`. Without
an environment they stay as they were. See [Caching](../workspace/caching.md).

**The planned node.** A planned target carries `nixEnvironment`: the store
path, its hash, the `PATH` entries, the carried variables, and `closure`, the
complete list of store paths the environment references. A sandbox that wants
to bind-mount exactly the toolchain the key names reads `closure`; it is the
read set the `nix:<hash>` layer stands for.

## CI

`CiToolchain.Nix({ environment })` makes a generated job install Nix and run
every step inside `nix develop` of the declared environment. The runner's own
interpreters are never installed, and a job that declares both a Nix
environment and a per-tool setup is refused rather than left to `PATH` order.

```ts
export const ci = Smithers.GithubCiGen({
  packageManager,
  jobs: [{
    id: "test",
    name: "workspace graph",
    runsOn: "ubuntu-latest",
    toolchain: Smithers.CiToolchain.Needs({
      nix: Smithers.CiToolchain.Nix({
        environment,
        substituter: Smithers.Secret("NIX_CACHE_URL"),
        publicKey: Smithers.Secret("NIX_CACHE_PUBLIC_KEY")
      })
    }),
    steps: [{ verb: Smithers.Verb.Ci, pattern: "//packages/..." }]
  }]
})
```

`substituter` and `publicKey` are `Secret` declarations. They reach the
workflow only as `secrets.<NAME>` expressions in the installer's extra
configuration, never as literal values. See
[GithubCiGen](../reference/targets/github-ci-gen.md).

## What an environment does not do

It does not sandbox. A tool still runs in the workspace with the narrow
ambient environment every tool gets; only its executable lookup changed. The
hermetic proofs that admit an artifact to the shared tier come from a sandbox
lane, and `closure` is the input that lane needs. See
[Actions and boundaries](actions-and-boundaries.md).

It does not enter the sandbox guest. A NixOS guest built from
`.smithers/environment.nix` and a build graph that declares the same file are
the same closure seen from two sides; the guest boots it, the graph keys on
it.

## Next

- [Caching](../workspace/caching.md)
- [GithubCiGen](../reference/targets/github-ci-gen.md)
- [First build](../getting-started/first-build.md)
