---
title: "Configuration"
description: "Where the cache directory comes from, what lives inside it, the confinement policy, and why the directory is never key material."
---

A workspace declares where the CLI keeps its cache and target scratch files, and
the confinement its tool-running targets execute under. Both live in the
workspace declaration.

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("//package.json")

export const runtime = S.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })
export const environment = S.Nix.Environment({ flake: S.file("//flake.nix") })

export const Workspace = S.Workspace("demo", {
  repository: "git+https://example.invalid/demo.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime,
  packageManager,
  nodeModules: S.Npm.NodeModules({ packageJson }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.Bubblewrap() })
})
```

`sandboxes` names the confinement mechanisms available to targets. `default` is
the one a target uses when it asks for confinement without naming another:
`S.Sandbox.Bubblewrap()` on Linux, `S.Sandbox.Docker({ image })` where the
platform's own mechanism is not wanted, and `S.Sandbox.None()` to turn
build-target confinement off. See
[Hermeticity](../concepts/actions-and-boundaries.md#hermeticity).

`remotes` names the machines `smthrs ci --remote <name>` splits a run across.
Each entry is `S.Remote.Command({ machines, workdir, setup?, cli? })`: one argv
prefix per machine (`["ssh", "ci-1"]`, `["docker", "exec", "-i", "ci"]`, or `[]`
for this machine), an absolute directory on each machine, the shell commands
that prepare the shipped tree, and the words that start the CLI there:

```ts
remotes: S.Remotes({
  boxes: S.Remote.Command({
    machines: [["ssh", "ci-1"], ["ssh", "ci-2"]],
    workdir: "/var/tmp/smthrs-ci",
    setup: ["pnpm install --frozen-lockfile"]
  })
})
```

`S.Remote.Http({ url, token, machines, limits?, workdir, setup?, cli? })`
reaches machines an HTTP service starts on demand, such as a Worker holding
Cloudflare containers: `machines` is how many one run starts, and `token` is an
`S.Secret` only the coordinator reads.

See
[Run CI on other machines](../../build-cli/docs/guides/run-ci-on-other-machines.md).
A module flow on the `smthrs` host reaches the same entries by name through
`Remotes` from `@smthrs/sandbox`, once its capabilities name `remote:acquire:<name>`; see
[Reach a declared remote from a flow](../../flows/sandbox/docs/guides/reach-a-declared-remote.md).

`S.Workspace` validates its options and performs no I/O, so evaluating the
module stays pure. For the full option list and every refusal, see
[the workspace reference](../reference/config.md).

Bubblewrap cannot expose host loopback without exposing the whole host network,
so Linux refuses `{ network: "loopback" }`; use `{ network: true }` only as an
explicit full-network opt-in. Targets that declare `services` must declare one
of those network postures themselves.

`S.Workspace` validates its options and performs no I/O, so evaluating the
module stays pure. For the full option list and every refusal, see
[the workspace reference](../reference/config.md).

## Precedence

Every command settles the cache directory before it reads or writes anything.

1. The `--cache-dir` flag.
2. The `cache` declaration in `WORKSPACE.ts`.
3. `.flows`.

Both the flag and the declaration go through the same validation, so an absolute
path, a `..` segment, or an empty value fails the command regardless of where it
came from.

```bash
smithers-build build //... --cache-dir .smithers-build-cache
```

Add the resolved directory to your `.gitignore`. It holds replayable state that
no commit should carry.

## What lives in the cache directory

| Path                                      | Written by                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| `<cacheDirectory>/cache/<xx>/<key>.json`  | The result cache, one JSON file per stored target result                         |
| `<cacheDirectory>/knip-<fingerprint>.mjs` | `DepsLint`, when its ignore lists are non-empty and the tool is knip             |
| `<cacheDirectory>/sandbox/<run>`          | A confined run's private temporary directory and home; removed when the run ends |

Package-manager stores are not controlled by this setting. They stay at
`.flows/store/<manager>` because fetch declares those fixed paths as
`TreeArtifact` boundaries. The `install` verb requires the default `.flows`
configuration; build, test, lint, docs, run, query, graph, and CI accept a
custom directory.

## Why the directory is not key material

The resolved cache directory is host state. It names where one machine keeps
replayable files, and two checkouts that configured it differently must still
agree on every content key.

Three mechanisms keep it out.

- **Discovery** drops the directory and the fixed `.flows/store` subtree from
  both the git listing and the fallback walk, even when the workspace does not
  ignore them.
- **Glob expansion** receives the resolved directory explicitly and refuses to
  descend into it. A `file()` declaration that resolves inside it expands to an
  empty file list.
- **Tool execution** never receives the real path in an action payload.
  `DepsLint` emits the constant token `{smthrs:cache-directory}` at plan time,
  and the exec layer substitutes the validated host directory into the argv
  immediately before spawn.

## Next

- [Caching](caching.md)
- [Workspace reference](../reference/config.md)
- [Workspace structure](structure.md)
