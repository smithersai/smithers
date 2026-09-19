---
title: "Installation"
description: "Install the smthrs executable, the Node version it requires, the runners it supports, and the import forms of the library."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/installation.md"
---

## Install the executable

As checked on September 4, 2026, `1.0.0-rc.0` is not published to npm and the CLI has no `next` dist-tag. For now, use the [source-checkout installation](https://smithers.sh/docs/installation/#use-the-source-checkout-before-publication). The npm commands on this page apply after publication.

```bash
npm install --global @smthrs/cli@1.0.0-rc.0
```

The package installs one executable under two names, `smthrs` and its
`smithers` alias. Both are the same file, `bin/smithers.mjs`.

The executable declares `@effect/sql-sqlite-node@4.0.0-rc.115` as a required
peer because its default runtime opens SQLite. Modern npm and pnpm install
that peer with the CLI, along with its required Effect Node adapter. The
database library itself keeps SQLite optional for driver-neutral consumers.

Name the version. These pages describe 1.0.0-rc.0, and until that release
candidate reaches the registry the unqualified package name still resolves to
the 0.x line, whose commands and output these pages do not describe. A release
candidate publishes under the `next` dist-tag rather than `latest`, so
`@next` names the newest one once it is there.

Confirm what you got, and what the registry offers, with the CLI itself:

```bash
smthrs --version
smthrs update
```

`smthrs update` compares `Version.packageVersion` against the `next` and
`latest` dist-tags and prints the `npm install` line for the newer one. It
changes nothing, and it prefers `next`, so an rc install is never told to
downgrade to a 0.x `latest`.

## Requirements

- Node 22.19+ (Node 22) or 24.11+. The durable engine requires it, `smthrs doctor`
  reports a `fail` outside this range. `Doctor.supportedNodeRange` matches the
  published manifest; Node 23 and Node 24.0 through 24.10 are not supported.
- A project directory. Commands that touch durable state resolve a project
  root and write `.flows/` under it. See
  [The project and its state](/concepts/project-and-state/).
- A provider credential, for flows that call a model. `smthrs doctor` reports
  which of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `MOONSHOT_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and `CEREBRAS_API_KEY` are set, and names any that are exported but empty. The
  doctor check reports presence without printing credential values.
- `AI_GATEWAY_API_KEY`, to run an agent. The agent loop's last brake on a
  completion asks Jev whether the claim the run wrote matches the evidence the
  run produced, and it never falls back: without the key every run fails at its
  first completion with `completion_unjudged`. Flows that call no agent do not
  need it.

## Runners

The shebang in `bin/smithers.mjs` pins Node, because the durable engine is
not supported on Bun. That makes every installation path run on Node:

| Path | Command |
| --- | --- |
| Global install | `smthrs <verb>` |
| One-off through npm | `npx --package @smthrs/cli@next smthrs <verb>` |
| One-off through Bun | `bun x --package @smthrs/cli@next smthrs <verb>` |

Bun honours the shebang, so `bun x` starts Node. Running the CLI with
`bun --bun` overrides the shebang and is not supported.

## Workspace target commands

Global and one-off installations can initialize a project and operate its flows.
To load `WORKSPACE.ts` and `PACKAGE.ts`, install the CLI and declaration packages
in that workspace, then select its local binary. After publication:

```bash
smthrs init hello
pnpm add --save-dev @smthrs/cli@1.0.0-rc.0 @smthrs/targets@1.0.0-rc.0
pnpm exec smthrs targets
```

The loader and declarations must resolve the same physical Effect and Smithers
packages. A separately installed global CLI can report
`declaration_dependency_mismatch` even when versions match. Before publication,
use the checkout's workspace dependency graph. The
[first-target tutorial](https://smithers.sh/docs/tutorials/first-target/) walks
through local planning, execution, and cache reuse.

## Using the library

The package is also importable. The root entry point re-exports every module
as a namespace:

```ts
import { Command, NodeControl, Output, Verb } from "@smthrs/cli"
```

Each module is also importable from its own subpath, which is the form the
[API reference](/reference/api/) uses:

```ts
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Verb from "@smthrs/cli/Verb"
```

`@smthrs/cli/package.json` is exported. Two subpath forms are not public and
are blocked in the export map: `@smthrs/cli/internal/*` and
`@smthrs/cli/*/index`.

The package depends on the whole Smithers stack, including
[`@smthrs/control`](https://control.smithers.sh/reference/api/), [`@smthrs/engine`](https://engine.smithers.sh/reference/api/),
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/), [`@smthrs/gateway`](https://gateway.smithers.sh/reference/api/), and
[`@smthrs/journal`](https://journal.smithers.sh/reference/api/). Installing it installs them, so a host that
embeds the command tree adds no further packages. See
[Embed the command tree](/guides/embed-the-command-tree/).

## Next step

Run one project from `init` to a settled run in the [Quickstart](/quickstart/).
