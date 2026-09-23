---
title: "Nested repositories"
description: "Declare a complete Smithers workspace nested inside another one, keep the two label graphs separate, and depend on a child target by label."
sidebar:
  order: 5
---

A repository sometimes contains other repositories: a vendored SDK, a sample
app, a fixture with its own workspace. `S.LocalRepository` declares those
boundaries. The loader treats each declared repository as opaque and never
merges the child's packages into the parent label graph, so a child's
root-anchored `//` inputs keep meaning what the child says they mean.

## Declare repository boundaries

Name each repository in the root `S.Workspace` declaration under `repos`:

```ts
import { Smithers as S } from "@smthrs/targets"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })

export const Workspace = S.Workspace("parent", {
  repository: "git+https://example.com/parent.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.21.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  repos: {
    app: S.LocalRepository("app"),
    sdk: S.LocalRepository("vendor/sdk", { branch: "main" })
  }
})
```

Repository paths are workspace relative. Absolute paths, `..` segments, and two
declarations that normalize to the same path are invalid. At load time each
path must be a directory holding `.smithers/WORKSPACE.ts` or `WORKSPACE.ts`.

Discovery prunes every declared repository before it looks for parent
`PACKAGE.ts` files. A nested workspace that no declaration names fails with
`nested_workspace_undeclared` and a declaration example, rather than having its
packages silently interpreted against the parent.

## Inputs that enter a repository

A broad parent glob stops at repository boundaries:

```ts
const parentFiles = S.glob("**")
```

A pattern whose literal prefix reaches into a repository is explicit, so it
stays valid:

```ts
const deployment = S.glob("app/infra/**")
const manifest = S.file("vendor/sdk/Cargo.toml")
```

Explicit repository globs still exclude `.git`, `node_modules`, and nested
`.flows` state. Declaring a repository changes the parent graph digest by its
name and path, and the loader does not scan child contents for that digest.

## Depend on a child target

`S.Repo.Target` adds one parent node that delegates to an exact child label:

```ts
const sdkTests = S.Repo.Target("sdk", "//crates/sdk:test", {
  data: [S.file("vendor/sdk/Cargo.lock")],
  args: ["--no-cache"]
})

export const Package = S.Package({
  targets: {
    sdkTests,
    ci: S.Suite({ tests: [sdkTests] })
  }
})
```

The first argument is either the `repos` name or the `S.LocalRepository`
declaration itself. The child label must use the absolute `//package:name`
spelling; a relative `:name` label is rejected. `data`, `gates`, and `sandbox`
take the same shapes they take on a shell target, and `args` are appended after
the child label.

Query and graph operations invoke the same CLI in the child directory with
`query <label> --format json`. Query reports the child's target kinds, and
graph renders the external edge as `@sdk//crates/sdk:test`. A child graph that
refuses to load does not stop the parent graph from loading: the repository
target reports no kinds and carries the child's refusal in query and graph
output.

## Execution and caching

Execution invokes the same Node.js process and build entry point with the child
repository as both `cwd` and `--workspace`. Parent write and plan modes are
forwarded first, then the declared `args`. Child stdout and stderr stream
through the parent process.

The parent cache key covers the child `HEAD`, the full `git status --porcelain`
state, the child label and args, and the parent `data` inputs. A dirty child
repository never reads or writes a parent result-cache entry.

The outer child CLI process runs without a macOS sandbox, deliberately: nesting
the parent sandbox would stop the child CLI from applying the sandbox policies
its own targets declare. The child target executor stays responsible for its
declared sandbox, and the parent logs that delegation.
