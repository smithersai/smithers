---
title: "Default targets"
description: "PackageDefaults: synthesizing targets for directories with no PACKAGE.ts of their own, and the marker, unless, directories, and macro options."
---

Examples importing `buildAndCheckPackage` use the [local helper defined here](../reference/targets/standard-package.md). Create that file in your repository before using those examples.

A default target synthesizes targets for directories that have no `PACKAGE.ts` of
their own. It is how one declaration covers every conventional package in a
workspace.

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// PACKAGE.ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=26.4.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: buildAndCheckPackage,
  attrs: { packageManager }
})
```

Every directory under `packages/` that contains a `package.json` and no
`PACKAGE.ts` now exports `lib`, `test`, and `lint`.

## Options

| Option        | Type                      | Default          | Description                                                                                                            |
| ------------- | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `directories` | `string \| Input.Glob`    | required         | Which directories the declaration covers. A string lifts to `glob(string)` and resolves against the declaring package. |
| `marker`      | `string`                  | `"package.json"` | A file that must exist in a directory for it to be eligible.                                                           |
| `unless`      | `string`                  | `"PACKAGE.ts"`   | A file that, if present, makes the directory ineligible.                                                               |
| `macro`       | `(attrs) => object`       | required         | Called once per eligible directory.                                                                                    |
| `attrs`       | `Record<string, unknown>` | `{}`             | Passed to the macro, over a `cwd` default. Supply the toolchain here: `attrs: { packageManager }`.                     |

`PackageDefaults` validates and lifts the declaration while performing no I/O.

The declaration is a `PACKAGE.ts` export, so it is discovered the same way targets
are. It is not a target and gets no label. Declare workspace-wide defaults in the
root `PACKAGE.ts`; the workspace loads that file before it synthesizes anything.

## Eligibility

A directory is eligible for a declaration when all three hold:

1. The `marker` file exists directly inside it.
2. The `unless` file does not.
3. The directory matches the `directories` glob, and no `exclude` pattern of that
   glob.

Both the pattern and its excludes resolve against the package path of the
`PACKAGE.ts` that exported the declaration, so a declaration in the root uses
workspace-relative patterns. Matching uses `minimatch` with `dot: true`, against
the directory path itself, not its contents.

The workspace enumerates candidate directories from the discovered file list: for
each declaration, every file equal to or ending in `/<marker>` names a candidate
directory. Directories are checked in sorted order, and the first eligible
declaration wins.

## Synthesis

For an eligible directory, the workspace calls:

```ts
macro({ cwd: directory, ...attrs })
```

`cwd` comes first, so a declared `attrs.cwd` overrides it. Every property of the
returned object that passes `Target.isTarget` becomes a synthesized target, named
by its property key, with names sorted so labels are deterministic. Non-target
properties are ignored.

The labels are path-derived exactly like exported ones. A synthesized
`packages/greeter` produces `//packages/greeter:lib`, `//packages/greeter:test`,
and `//packages/greeter:lint`.

A macro that returns no targets fails with
`default target synthesized no targets for //<directory>`.

Synthesis is memoized per directory, and the same duplicate-label guard applies:
one target value registered under two labels fails the command.

## Selection

Synthesized targets participate in patterns the same way exported ones do.

- `//packages/greeter:lib` resolves through synthesis when that directory has no
  `PACKAGE.ts`.
- `//packages/greeter` picks its default through the usual `lib`, `nodeModules`,
  basename, `default`, sole-export search.
- `//packages/...` includes every eligible directory in the subtree.

An exact label for a package that has neither a `PACKAGE.ts` nor a matching
declaration fails with
`package //<path> has no PACKAGE.ts and matches no default target`.

## Opting out

Write a `PACKAGE.ts`. The `unless` file defaults to `PACKAGE.ts`, so the directory
stops being eligible the moment it has one, and its explicit targets take over.
That is the intended upgrade path: start with a default target, and write a real
`PACKAGE.ts` for the packages that need something different.

## Limitation: no edges

Synthesis passes one static `attrs` value to every match, so a synthesized
package carries no dependency edges even when its `package.json` names workspace
siblings. Its targets still resolve the runtime and package manager from the
workspace declaration; what they cannot get is an edge to a sibling.

A synthesized package that needs edges gets a real `PACKAGE.ts`:

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
// packages/app/PACKAGE.ts
import { Smithers as S } from "@smthrs/targets"
import { Package as greeter } from "../greeter/PACKAGE.ts"

const { lib, test, lint } = buildAndCheckPackage({ deps: [greeter.lib], cwd: "packages/app" })

export const Package = S.Package({ targets: { lib, test, lint } })
```

How synthesized packages should infer edges from each other, for example from
the `package.json` dependencies on workspace siblings, is an open design
question.

## Several declarations

A workspace can export more than one declaration. They are checked in the order
they were discovered, and the first eligible one wins for a given directory.
Scope them with disjoint globs or distinct markers:

```ts
import { buildAndCheckPackage } from "./package-targets.ts"
export const nodePackages = PackageDefaults({
  directories: glob("packages/*", { exclude: ["packages/web-*"] }),
  marker: "package.json",
  macro: buildAndCheckPackage,
  attrs: { packageManager, deps: [] }
})

export const webPackages = PackageDefaults({
  directories: glob("packages/web-*"),
  marker: "package.json",
  macro: BrowserPackage,
  attrs: { packageManager, deps: [] }
})
```

## Next

- [Writing macros](writing-macros.md)
- [Workspace structure](../workspace/structure.md)
- [Labels](../concepts/labels.md)
