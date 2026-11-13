---
title: "Filegroup"
description: "Names a set of files under one label, so other targets depend on the set instead of repeating its globs."
---

Names a set of files under one label so other targets depend on the set instead
of repeating its globs. It follows Bazel's `filegroup`.

```ts
import { Smithers } from "@smthrs/targets"

const protos = Smithers.Filegroup({
  srcs: [Smithers.glob("proto/**/*.proto")],
  cwd: "packages/wire"
})

const wireInputs = Smithers.Filegroup({
  srcs: [Smithers.file("schema.json"), protos],
  cwd: "packages/wire"
})

export const Package = Smithers.Package({
  targets: { protos, wireInputs }
})
```

## Attributes

| Name   | Type                                               | Default  | Description                                                                                                                                                          |
| ------ | -------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `srcs` | `Array<Input.File \| Input.Glob \| Target.Target>` | required | The files, globs, and targets the group names, in read order.                                                                                                        |
| `cwd`  | `string`                                           | `"."`    | Package directory the declared paths and patterns resolve from. The default means the declaring PACKAGE.ts package; an explicit non-dot value is workspace relative. |

## Composition

Groups compose. A group whose `srcs` name other groups expands to their
transitive union, walked depth first in `srcs` order. Each nested group is
entered once, so a diamond contributes its shared members once and the result
is deterministic. Nested sources resolve against the nested group's own `cwd`.

`Filegroup.sources(attrs, context)` is the pure flattening used by the target
body and file-set composition. It returns `Filegroup.AnchoredSource` entries
with `{ base, source }`, retaining each default-cwd group's declaring package
directory. `ExpandFilegroupLive` maps those anchors onto its workspace before
expanding and digesting the sources. An explicit `cwd` remains workspace relative,
and a source's `//` prefix still resolves from the workspace root.
`Filegroup.expand(root, sources)` remains the lower-level helper for sources
that are already workspace relative.

## Consumers

A group in another target's attrs is an ordinary dependency edge, so the group is
built first and its key reaches the consumer's key. The planner also projects
the group's contents directly: `Workspace.expandInputs` walks every group
reachable from the target and adds that group's own declarations, expanded
against the group's package directory, to the consumer's declared inputs.

Editing any member of any group therefore invalidates every consumer of that
group. The projection deduplicates declarations the target or a shallower group
already contributed, and it walks in `srcs` order, so it is deterministic.

## Inputs

Declared files and globs inside `srcs` are collected by `Target.make` as ordinary
declared inputs. Nested groups become dependencies.

Globs are package scoped, as they are in Bazel: expansion never descends into a
subdirectory holding a `PACKAGE.ts` file. See
[Glob expansion](../../concepts/inputs.md#glob-expansion). That target applies to
every glob in every target, not only to groups.

## Channels

| Channel | Type                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- |
| Success | `Filegroup.Files`, an array of `{path, digest}` with a null digest for a file that does not exist |
| Error   | `Filegroup.FilegroupError`                                                                        |

## Status

|           |                                                              |
| --------- | ------------------------------------------------------------ |
| Kinds     | none                                                         |
| Cacheable | Always                                                       |
| Executes  | Yes, through `ExpandFilegroupLive`, but only as a dependency |

`kinds` is empty, so `smithers-build build`, `test`, `lint`, and `docs` never select a
group as a root and a group never performs work under those verbs. Dependency
traversal, `query`, and `graph` ignore kinds, so a group is still addressable by
label, still listed by `smithers-build query`, and still traversed by `deps(...)`.
Executing a group reached as a dependency is a successful no-op: it reads the
files the group names and succeeds with them digested.

## Deviations from Bazel

Where the two disagree, smithers build follows Bazel. These three are deliberate
departures, recorded here and in the module JSDoc.

- **No visibility.** Bazel gates every target behind `visibility`, and a
  `filegroup` is the usual way to publish files across package boundaries.
  smithers build has no visibility system yet, so every group is effectively public.
  Groups get visibility when every other target does.
- **No `exports_files`, and `//`-anchored `file()` references stay legal.** In
  Bazel a package must export a file before another package may name it.
  smithers build lets any target write `file("//path/to/file")` directly, so a group is
  a convenience for naming a set rather than the only legal way to cross a
  package boundary.
- **A non-group target in `srcs` contributes no files.** Bazel takes such a
  target's default output group. smithers build has no output-file model yet, so a
  plain target in `srcs` stays an ordinary dependency edge, built before the
  group and with its key reaching the group's key, but it adds nothing to the
  file list.

## See also

- [Inputs](../../concepts/inputs.md)
- [Dependencies](../../concepts/dependencies.md)
- [Labels](../../concepts/labels.md)
