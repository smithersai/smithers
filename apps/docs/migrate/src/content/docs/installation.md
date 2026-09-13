---
title: "Installation"
description: "Three ways to run the migration tool, the two install shapes it has, its Node and package requirements, and the import forms of its scanner API."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/migrate/docs/installation.md"
---

## Availability

The Smithers 1.0 packages are not on npm yet, so every `npx` and install line
on this site resolves once they publish. Until then, run the tool from a source
checkout of the
[smithers repository](https://github.com/smithersai/smithers):

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
pnpm --filter @smthrs/migrate build
node packages/smithers/migrate/dist/esm/flow/bin.js --root /path/to/project
```

That executable takes the flags this site documents, so the rest of these pages
read the same from a checkout as they will from a registry.

## Run it without installing anything

The tool has to run inside a project that does not have Smithers 1.0 yet, so
the first command needs no install:

```bash
npx @smthrs/migrate@next
```

The package ships one executable, `smithers-migrate`, and `npx` runs it. With
no flags the mode is `plan`: it reads the project, plans the units, and writes
the report.

## Install it as a project dependency

Install the package when you want the scanner API in your own script, or when
you want the tool pinned in the project you are migrating:

```bash
npm install --save-dev @smthrs/migrate@next
pnpm add -D @smthrs/migrate@next
yarn add -D @smthrs/migrate@next
bun add -d @smthrs/migrate@next
```

The package requires Node.js 22.19+ (Node 22) or 24.11+, and ships as both ESM and
CommonJS with TypeScript declarations.

Syntax scanning uses TypeScript 7's version-pinned `unstable` API. It parses
the supplied text in a closed virtual project, without reading the project's
configuration or dependencies, checking types, emitting files, or executing
source. One scan shares a compiler session and caches syntax trees by path and
content across its passes. The session and cache are released when the scan
ends, including on failure or interruption. An isolated parse closes its own
session before returning the tree. Keep
npm's platform-specific optional dependencies enabled so the native compiler
executable is installed. The classic compiler used to validate test fixtures
is a development dependency, not part of the published runtime.

## Run it as a CLI verb

Once the project is on 1.0, the same entry point is reachable as a verb of the
Smithers CLI:

```bash
pnpm add -D @smthrs/cli@next
smthrs migrate --scan
```

`@smthrs/cli` is the one package you install by hand for the migration. The
tool installs everything else the migrated project needs: its `dependencies`
unit adds the `@smthrs/*` packages and `effect` to your manifests, and its
final `project` unit removes the 0.x packages once nothing depends on them. Do
not remove the old packages yourself before you run it. The scanners decide
what a dependency is from the manifests, so a manifest you have already emptied
is a project the tool can no longer read correctly.

[`smthrs migrate`](https://smithers.sh/docs/reference/cli/migrate/) and `smithers-migrate` share one entry point
and take the same flags, with two differences. The CLI names the project as a
positional path argument, defaulting to the 0.x project root found by walking
up from the working directory; the bin names it with `--root <path>`,
defaulting to the working directory itself. And the CLI refuses up front, with exit 1
and no flag to release it, a project whose 0.x database still holds runs that
have not finished.

The flag reference for both is [the `smthrs migrate` page](https://smithers.sh/docs/reference/cli/migrate/).

## The two install shapes

The package has a read-only half and an editing half, and they need different
things.

`scan` and `plan` need `effect`, `@effect/platform-node`, and `typescript`, and
nothing else. Every scanner module imports only those and Node built-ins.

`apply` runs the migration flow and its registry discovery check, so it also
needs the flow-lane packages: `@smthrs/agent`, `@smthrs/core`,
`@smthrs/engine`, `@smthrs/flow`, `@smthrs/harness`,
`@smthrs/kernel`, `@smthrs/model`, `@smthrs/plan`,
`@smthrs/platform-node`, and `@smthrs/registry`. They are
declared as `optionalDependencies`, so a package manager installs them by
default and `--no-optional` leaves them out:

```bash
pnpm add -D @smthrs/migrate@next --no-optional
```

That flag also omits TypeScript's platform-specific native compiler package.
A scan-only installation must supply that compiler executable separately;
otherwise keep optional dependencies enabled. `Checks.discovery` imports
`@smthrs/registry` at call time, so importing `@smthrs/migrate` never loads the
runtime even when the optional packages are present.

## Provider credentials

`apply` runs a model-backed rewrite, so it needs a seat and a key. Name the
seat with `--seat provider:model`, and put the provider's key in the
environment:

| Provider     | Variable             |
| ------------ | -------------------- |
| `anthropic`  | `ANTHROPIC_API_KEY`  |
| `openai`     | `OPENAI_API_KEY`     |
| `openrouter` | `OPENROUTER_API_KEY` |

```bash
ANTHROPIC_API_KEY=... npx @smthrs/migrate@next --apply --seat anthropic:<model>
```

No model id is hard coded anywhere in this package, so the seat resolver
refuses by name rather than guessing: with a key but no `--seat` it names the
provider it found a key for, and with neither it names the three variables.
Either way the unit fails with that refusal in its report entry. `scan` and
`plan` need no credentials at all.

## Import forms

The root entry point re-exports the scanner modules as namespaces:

```ts
import { Constructs, Detect, Inventory, Mapping, Report, RunState, Scan, Units } from "@smthrs/migrate"
```

Each module is also importable from its own subpath, which is the form the
[API reference](/reference/api/) uses:

```ts
import * as Report from "@smthrs/migrate/Report"
import * as Scan from "@smthrs/migrate/Scan"
```

The editing half lives under `@smthrs/migrate/flow/`:

```ts
import * as Command from "@smthrs/migrate/flow/Command"
```

`Contract`, `Gate`, and `Options` are the three flow modules the root entry
point also exports, because they describe a run rather than execute one.
`@smthrs/migrate/internal/*`, `@smthrs/migrate/flow/internal/*`, and
`@smthrs/migrate/*/index` are not public; all three are blocked in the export
map. `@smthrs/migrate/package.json` is exported.

## Next step

Migrate one project end to end in the [Quickstart](/quickstart/).
