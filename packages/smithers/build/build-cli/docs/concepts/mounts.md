---
title: "Mounts"
description: "Run an overlay repository's targets against an upstream repository it never forks: a pinned commit, a drift policy, explicit patches, and a checkout the CLI materializes before it plans."
sidebar:
  order: 7
---

A mount lets you automate a repository you do not own. The automation lives in
an overlay repository that holds a `.smithers/` directory and nothing else. Its
`.smithers/config.ts` names the upstream repository and the commit to pin.
Every command run from the overlay fetches that commit, lays the overlay's
`.smithers/` over it, and plans against the result, so the overlay's targets
run as if they lived upstream. The upstream repository is only ever read.

## Declare a mount

`.smithers/config.ts` default-exports `S.Mounts`, one `S.Mount` per upstream
repository:

```ts
// .smithers/config.ts
import { Smithers as S } from "@smthrs/targets"

export default S.Mounts({
  effect: S.Mount({
    repository: "https://github.com/Effect-TS/effect.git",
    ref: "b04191b2941534754282c51ef2df2f965ac43a5c",
    track: "main",
    drift: "warn",
    patches: ["patches/effect/0001-fix-stream-finalizer.patch"]
  })
})
```

| Field        | Meaning                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `repository` | A git URL or path the checkout fetches from.                                                              |
| `ref`        | The pin: a full lowercase commit id. A branch or tag is refused because it can move under the pin.        |
| `track`      | The branch drift is measured against. Optional under `warn`; required by `refuse` and `follow`.           |
| `drift`      | `warn` (default), `refuse`, or `follow`. See [Pins and drift](#pins-and-drift).                           |
| `patches`    | Patch files relative to `.smithers/`, applied in order. Default none.                                     |
| `overlay`    | The directory under `.smithers/` laid over the checkout's `.smithers/`. Default `.`, the whole directory. |

The rest of the overlay's `.smithers/` is an ordinary workspace descriptor:
`WORKSPACE.ts` declares the upstream's runtime and package manager, and
`PACKAGE.ts` files under `.smithers/` declare targets whose inputs are
upstream paths:

```ts
// .smithers/effect/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"

const install = S.Install({
  lockfilePath: "pnpm-lock.yaml",
  workspaceManifest: S.pnpmWorkspace("//pnpm-workspace.yaml")
})

const test = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run", "--project", "effect"],
  data: [install, S.glob("//packages/effect/src/**/*.ts"), S.glob("//packages/effect/test/**/*.ts")]
})

export const Package = S.Package({ targets: { install, test } })
```

Run it from anywhere in the overlay:

```bash
smthrs test '//.smithers/effect:test'
```

The command prints one line about the mount on standard error, then runs:

```text
mount effect: b04191b29415 + 0 patches from https://github.com/Effect-TS/effect.git at .mounts/effect; main is current
```

## What materializing does

Before any command opens its target index, the CLI looks for the nearest
`.smithers/config.ts` above the working directory. When it finds one, it
materializes the mount and opens the checkout instead:

1. It reads `track` with `git ls-remote` and applies the drift policy.
2. It fetches the commit into `.mounts/<name>` at the overlay root, shallow
   by commit id, and checks it out detached.
3. It applies each patch with `git apply --index` and commits it, so the
   checkout's `HEAD` is the pin plus one commit per patch.
4. It lays the overlay: it copies the overlay's files into the checkout's
   `.smithers/`, except `config.ts`, the declared patches, and other mounts'
   overlay directories, and removes files an earlier lay placed that the
   overlay no longer has.
5. It records what it did in `.mounts/<name>/.git/smithers-mount.json`.

The next command compares that receipt with the declaration. With the pin,
patches, and overlay unchanged it fetches nothing and rewrites nothing, so a
mounted command costs one `ls-remote` more than an ordinary one. The overlay
repository never tracks a checkout: `.mounts/.gitignore` ignores everything
below it. A command run from inside `.mounts/<name>` treats the checkout as an
ordinary workspace and does not materialize again.

Labels resolve against the checkout, so a target declared in the overlay's
`.smithers/effect/PACKAGE.ts` is `//.smithers/effect:<name>`, and `//` paths in
its inputs name upstream files.

## Pins and drift

The pin is a commit id because the materialized tree must be the same tree on
every machine. `track` and `drift` decide what happens when upstream moves:

| `drift`  | Tracked branch past the pin                                   | Tracked branch unreadable |
| -------- | ------------------------------------------------------------- | ------------------------- |
| `warn`   | Materializes the pin and reports the branch tip.              | Materializes the pin.     |
| `refuse` | Fails with `mount_drift` and names the tip to pin.            | Fails with `mount_drift`. |
| `follow` | Materializes the tip instead of the pin; patches still apply. | Fails with `mount_drift`. |

`warn` suits local work. `refuse` suits a scheduled CI job that should fail
until someone moves the pin. `follow` suits a canary that wants to learn early
when a patch stops applying.

## Patches

A patch changes upstream source, so it is the last resort: fix the defect
upstream when you can. When you cannot wait, a patch works the way
`pnpm patch` and `patch-package` do. It is a unified diff against the pinned
commit, kept in the overlay and listed in `patches`:

```bash
# Edit the checkout, then save the edit as a patch in the overlay.
git -C .mounts/effect diff > .smithers/patches/effect/0001-fix-stream-finalizer.patch
git -C .mounts/effect checkout -- .
```

Add the path to `patches`, and the next command applies it. A patch that does
not apply fails with `mount_patch_failed`, naming the patch and the commit, so
a moved pin or `follow` surfaces a stale patch before any target runs.

## Sending work upstream

The checkout is a git repository whose `HEAD` is the pin plus the declared
patches. Two diffs are ready to send:

- `git -C .mounts/<name> diff` is your uncommitted change on top of the
  patches. A target that declares `S.gitDiff()` reviews exactly this diff, so
  an agent lane judges what an upstream pull request would carry.
- `git -C .mounts/<name> diff <pin>` is the patches plus your change: the
  whole pull request. `git format-patch <pin>` turns the patch commits into
  mail-ready patches.

To open the pull request, push the checkout's `HEAD` to a fork of the upstream
repository and open it there. Once upstream merges it, move the pin past the
merge and delete the patch.

## Edits the mount protects

Materializing never discards work silently:

- Edits to upstream files in the checkout, and commits on top of the
  materialized commit, survive every command while the base and the patches
  hold still. A command that would check out a new base fails with
  `mount_dirty` and lists the edited paths or the commits it would drop. Push
  or save the commits, then reset the checkout to the materialized commit.
- A laid `.smithers/` file edited in the checkout fails the next lay with
  `mount_overlay_edited`. Edit the overlay, not the copy.
- An overlay file that would replace a file upstream tracks, or be laid
  through a symbolic link or file upstream tracks at `.smithers/` or below,
  fails with `mount_overlay_collision`. Change upstream files with a patch.

## Several mounts in one overlay

One overlay can automate several upstream repositories. Give each mount its
own `overlay` directory:

```ts
// Each pin is a full commit id, as for a single mount.
declare const effectPin: string
declare const viemPin: string

export default S.Mounts({
  effect: S.Mount({ repository: "https://github.com/Effect-TS/effect.git", ref: effectPin, overlay: "effect" }),
  viem: S.Mount({ repository: "https://github.com/wevm/viem.git", ref: viemPin, overlay: "viem" })
})
```

`.smithers/effect/` becomes the Effect checkout's `.smithers/`, and
`.smithers/viem/` becomes viem's. A command run from inside
`.smithers/<overlay>` selects that mount; from anywhere else in an overlay with
several mounts, the command fails with `mount_ambiguous` and lists them.

## Why a materialized checkout

Two designs were drafted for this feature.

- **Run from the overlay with upstream as a mounted source root.** The
  overlay is the workspace and upstream sits under it, for example at
  `upstream/`. Every `//` label would mean the overlay, so upstream's own
  relative configuration (a `tsconfig.json` `extends`, a Vitest `projects`
  list, a pnpm workspace file) would resolve against the wrong root. Discovery
  already prunes a nested checkout, and a child workspace needs its own
  `WORKSPACE.ts`, which is the fork this feature exists to avoid. Making it
  work would put two roots into every path the planner, cache, and sandbox
  resolve.
- **Materialize upstream and lay the overlay over it.** The checkout is a
  workspace like any other, so discovery, labels, caching, sandboxing, and
  every rule work unchanged, and the overlay's targets see the tree upstream's
  own tools expect. The cost is a second copy of upstream on disk and one
  network call per command.

Smithers materializes, because the first design changes every path consumer
and the second changes one: the function that picks the workspace root.

The checkout is a plain git repository rather than a jj workspace because the
upstream is a git remote, a shallow fetch by commit id keeps it small, and the
patch commits give `git diff <pin>` the upstream pull request for free.
