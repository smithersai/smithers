# Dependency-bound build targets

`.smithers/WORKSPACE.ts` declares the toolchain once, and each `PACKAGE.ts` declares that package's targets. Both import one namespace from `@smthrs/targets`.

## Declarations are data

Every target constructor is pure. It validates its attributes, records the inputs and dependencies it names, and returns a declaration; `@smthrs/build-cli` runs it.

- Declared inputs such as `Smithers.file` and `Smithers.glob` name what a target reads. Their content digests are the target's key.
- A target that exits zero without producing a declared output fails.
- `Smithers.Secret` names an environment variable, never a value.

Tool-running rules ask the workspace declaration for their interpreter and package manager, so switching either is one edit to `WORKSPACE.ts`.

## Crossing package boundaries

Globs are package scoped: expansion never descends into a subdirectory holding a `PACKAGE.ts` file. A `Filegroup` names a set of files under one label; its `cwd` defaults to the declaring package, and an explicit value is workspace relative. A group in another target's attributes is a dependency edge, so editing any member invalidates every consumer. A `//`-anchored `file()` reference may also name a file in another package directly.

## The wiki's targets

`flows/wiki/PACKAGE.ts` declares three targets over `flows/wiki/main.ts`, with exact `//` file inputs rather than cross-package globs:

| Target | Runs |
| --- | --- |
| `preview` | `main.ts`, writing `.flows/wiki` |
| `verify` | `main.ts --verified` |
| `freshness` | `main.ts --check`, after `preview` |

Every page's document and inputs, the catalog itself and the wiki recipe files are the targets' `data`, so editing any of them invalidates the wiki. The page catalog is the `pages` array of `.smithers/coding-project.json`.
