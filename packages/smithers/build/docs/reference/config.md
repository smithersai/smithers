---
title: "Workspace reference"
description: "The workspace declaration: where it lives, every option it accepts, the values it refuses, and how the cache directory is normalized."
---

A workspace declares itself once, in a `WORKSPACE.ts` module that exports a
single value named `Workspace`:

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")

export const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules: S.Npm.NodeModules({ packageJson })
})
```

The declaration is inert. `S.Workspace` validates its arguments and performs no
I/O, so evaluating the module reads nothing and spawns nothing.

## Where the file lives

The CLI looks for `.smithers/WORKSPACE.ts` first, then a root `WORKSPACE.ts`.
The first one it finds is the workspace declaration.

The module may export other declarations, as the example exports `runtime` and
`packageManager`, but three exports are refused:

| Export                                     | Refusal                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| A workspace declaration under another name | `a workspace declaration is exported as "x"; the one legal export name is Workspace`      |
| A second workspace declaration             | `WORKSPACE.ts exports more than one workspace declaration`                                |
| A target, or a `Package` value             | `WORKSPACE.ts exports a naked target "x"`; targets are addressable only through a package |

A module with no `Workspace` export fails with `WORKSPACE.ts has no Workspace
export`. The relationship with package modules is one way: `WORKSPACE.ts` may
import its `.smithers` siblings and the root package, and no `PACKAGE.ts` may
import `WORKSPACE.ts`.

## The name

`S.Workspace(name, options)` takes the name first. It must be a portable
identifier: it starts with a letter or a digit and continues with letters,
digits, `.`, `_`, or `-`. Anything else fails with `Workspace name must be a
portable identifier`, and a non-string first argument fails with `Workspace name
must be a string; Workspace(name, options) takes the name first`.

## Options

`repository` and `cache` are required. Everything else is optional, and an
unknown key fails with `Workspace received unknown option "x"`.

| Option           | Type                                    | Description                                                                            |
| ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `repository`     | `string`                                | The repository this workspace is. A non-empty string.                                  |
| `cache`          | `S.Cache({ directory, remote? })`       | Where results are kept, and optionally the remote cache they replicate to.             |
| `runtime`        | `S.Runtime.Node` or `S.Runtime.Bun`     | The interpreter every tool-running target is held to.                                  |
| `packageManager` | `S.PackageManager.Pnpm` or `.Yarn`      | The manager targets run their tools through.                                           |
| `nodeModules`    | `S.Npm.NodeModules({ packageJson })`    | The installed tree the workspace depends on.                                           |
| `environment`    | `S.Nix.Environment({ flake })`          | The Nix closure tools resolve from. See [Environments](../concepts/environments.md).   |
| `toolchains`     | `Array<Declaration>`                    | Non-Node toolchain layers, such as `S.Rust.Toolchain`. Must be non-empty when present. |
| `sandboxes`      | `S.Sandboxes({ ... })`                  | The confinement mechanisms available by name.                                          |
| `host`           | `S.Host({ bins })`                      | Host binaries the workspace requires on `PATH`.                                        |
| `flags`          | `S.Flags(...)`                          | Workspace-wide flag declarations.                                                      |
| `agents`         | `S.Agents(...)`                         | The agents model-backed targets may name.                                              |
| `memory`         | `S.Memory.SmithersCloud(...)`           | The Smithers Cloud memory the workspace uses.                                          |
| `gitHooks`       | `Record<hook, target>`                  | One target per git hook. An unknown hook name is refused.                              |
| `repos`          | `Record<name, S.LocalRepository(path)>` | Nested workspaces, by name. Names must be portable and paths distinct.                 |
| `owners`         | `S.Owners.*`                            | Workspace-wide default owners. See [Ownership](../concepts/ownership.md).              |
| `teams`          | `S.Teams(...)`                          | The team names owner declarations may reference.                                       |

Two rules tie the toolchain options together:

- `runtime`, `packageManager`, and `nodeModules` are declared together or not at
  all. Declaring one or two fails with `Workspace runtime, packageManager, and
  nodeModules must be declared together`.
- A workspace declares at least one source of tools: that Node trio, an
  `environment`, or a non-empty `toolchains` list. With none of them the
  declaration fails.

## The cache directory

`S.Cache({ directory })` normalizes and validates the directory with the same
function the `--cache-dir` flag goes through, so both paths enforce the same
rules.

Normalization, in order:

1. Trim surrounding whitespace.
2. Split on `/` and `\`.
3. Drop empty segments and `.` segments.
4. Join the rest with `/`.

Refusals:

| Input                                                  | Error                                                  |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `""` or whitespace only                                | `cacheDirectory must not be empty`                     |
| A value that normalizes to no segments, such as `"./"` | `cacheDirectory must not be empty`                     |
| Starts with `/` or `\`                                 | `cacheDirectory must be workspace-relative: <value>`   |
| Starts with a drive letter, such as `C:\cache`         | `cacheDirectory must be workspace-relative: <value>`   |
| Contains a `..` segment                                | `cacheDirectory must not leave the workspace: <value>` |
| Contains a control character or malformed Unicode      | `cacheDirectory must be well-formed text...`           |
| Exceeds 4,096 UTF-8 bytes                              | `cacheDirectory must be at most 4096 UTF-8 bytes`      |
| A segment exceeds 255 UTF-8 bytes                      | `cacheDirectory segments must be at most 255...`       |

Examples:

| Input               | Result        |
| ------------------- | ------------- |
| `".flows"`          | `.flows`      |
| `"  .flows  "`      | `.flows`      |
| `"build\\cache"`    | `build/cache` |
| `"./build//cache/"` | `build/cache` |
| `"/tmp/cache"`      | error         |
| `"../cache"`        | error         |

The value can name a nested directory such as `build/cache`. It cannot be
absolute and cannot escape the workspace.

`S.Cache` accepts exactly two keys, `directory` and `remote`. A `remote` value
must be an `S.RemoteCache.make` declaration; see
[Remote caching](../workspace/remote-caching.md).

## Precedence

Every command settles the cache directory before it reads or writes anything:

1. The `--cache-dir` flag.
2. The `cache` declaration.
3. `.flows`.

Both the flag and the declaration go through the same validator, so an absolute
path, a `..` segment, or an empty value fails the command regardless of where it
came from.

## What the setting controls

| Path                                       | Written by                                                           |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `<cacheDirectory>/cache/<xx>/<key>.json`   | The result cache                                                     |
| `<cacheDirectory>/knip-<fingerprint>.json` | `DepsLint`, when its ignore lists are non-empty and the tool is knip |
| `<cacheDirectory>/sandbox/<run>`           | A confined run's private temporary directory, removed with the run   |

It does not control package-manager stores. Those stay at
`.flows/store/<manager>` because fetch declares that fixed path as its
`TreeArtifact` boundary. The `install` verb therefore requires the default
`.flows` setting; the other verbs accept a custom directory.

A workspace-local store is not shared: each clone and worktree downloads and
unpacks the whole dependency set and keeps its own copy, so an install cache
holds one full store per checkout. `PackageManager.Options.storeDirectory`
names an absolute host store outside the project root for a composition that
drives the manager directly; the install Flow refuses it. See
[Install](../concepts/install.md).

## Not key material

The resolved directory is host state and never reaches a cache key or a content
digest.

- Discovery drops the directory and the fixed `.flows/store` subtree from both
  the git listing and the fallback walk, even when the workspace does not ignore
  them.
- Glob expansion receives the resolved directory explicitly and refuses to
  descend into it. A `file()` declaration resolving inside it expands to an empty
  file list.
- Action payloads carry the constant token `{smthrs:cache-directory}` instead
  of the path. The exec layer substitutes the validated host directory into every
  argument immediately before spawn.

## Next

- [Configuration](../workspace/configuration.md)
- [CLI reference](cli.md)
- [DepsLint](targets/deps-lint.md)
