---
title: "Installation"
description: "Install the smthrs executable from npm, the Node version it requires, the runners it supports, and the import forms of the library."
sidebar:
  order: 1
---

## Install the CLI

The CLI is on npm under the `next` tag, which carries the 1.0 release
candidates; `latest` still points at 0.35.0. Use Node.js 22.19.0 or later.
Install Node from [the official downloads](https://nodejs.org/en/download).
On an Apple Silicon Mac, select macOS and ARM64, then open a new terminal and
check `node --version` before installing Smithers.

Install [Jujutsu](https://jj-vcs.github.io/jj/latest/install-and-setup/) (`jj`)
for repository operations and `jq` for the quickstart's JSON commands.
On macOS with [Homebrew](https://brew.sh/):

```bash
brew install jj jq
```

```bash
npm install -g smthrs@next
smthrs --version
```

`smthrs` is the package to install globally. Its `smthrs` executable, and the
`smithers` alias, run `@smthrs/cli`, which it installs as a dependency. Do not
install both packages globally: npm refuses the second `smthrs` link.
`@smthrs/platform-node`, which the CLI installs, ships the
`smithers-jj-export` helper that confined flow commands require, so there is
nothing to build.

A global CLI initializes a project and operates its flows. Target commands load
`WORKSPACE.ts` and `PACKAGE.ts`, whose declarations and the CLI must resolve the
same physical Effect and Smithers packages, so install the CLI in that
workspace and run its local copy, as
[Workspace target commands](#workspace-target-commands) shows.

## Verify the install

Provider SDKs load when their provider is selected. Version, help and unrelated
commands remain usable if the Claude Agent SDK cannot load; Claude Code refuses
the seat with an error naming `@anthropic-ai/claude-agent-sdk`. Repair the CLI
installation before retrying that provider.

SDK loads emit the `cli.provider.sdk.load` span, debug records and the
`smithers.cli.provider_sdk.resolved` / `smithers.cli.provider_sdk.failed` counters.
Counters measure resolution results, including Node's module-cache hits.
Failures warn with a safe loader-error code or error category. Raw loader
messages and causes are discarded. A judge whose provider SDK cannot load is
`unconfigured`, with the required package in its typed error.

```bash
smthrs doctor
```

`doctor` checks flow discovery, local state and database compatibility, the Node.js version, Jujutsu availability, and provider configuration without running a flow. It exits 1 when a check fails.

## Stay current

```bash
npm install -g smthrs@next
```

`smthrs update` reads npm's dist-tags for `@smthrs/cli` and never installs anything.

## Install the executable

The executable selects `effect@4.0.5` through its peer and depends on
`@effect/sql-sqlite-node@4.0.5` because its
default runtime opens SQLite, so every package manager installs it with the
CLI. The
database library itself keeps SQLite optional for driver-neutral consumers.
The CLI’s optional PostgreSQL adapter is `@effect/sql-pg@4.0.5`.

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

- Node 22.19.0 or later. The durable engine requires it, `smthrs doctor`
  reports a `fail` outside this range. `Doctor.supportedNodeRange` matches the
  published manifest.
- A project directory. Commands that touch durable state resolve a project
  root and write `.flows/` under it. See
  [The project and its state](./concepts/project-and-state.md).
- A configured subscription seat for model flows and their completion judge.
  For Codex, install the Codex CLI and run `codex login --device-auth`.
  A `codex:sol` seat calls the ChatGPT backend directly, signed with the
  access token in that login (`$CODEX_HOME/auth.json`, `~/.codex/auth.json`
  by default). Every call of a run carries the run's cache key as its session
  id, and the model's reasoning returns with the next call. Smithers reads the
  login and never writes it: when the token is near its expiry or the backend
  answers 401, Smithers asks the Codex CLI to refresh its own login and reads
  the file again. A delayed 401 is matched to the credential that signed that
  request, so a newer credential is reused. Stale refresh-lock reclamation
  uses a short SQLite transaction on `auth.json.refresh.guard.sqlite`. This
  empty, credential-free guard file stays beside the login; keep it in place
  while Smithers processes may be running. Set `SMITHERS_OPENAI_AUTH=chatgpt` to select Codex
  automatically or to run existing `openai:` seats on the login.
  A host with no ChatGPT login refuses the seat and names
  `codex login --device-auth`.
  For Claude, install Claude Code and run `claude auth login`; with no
  `ANTHROPIC_API_KEY` set, the `opus`, `sonnet` and `fable` seats (and their
  `claude-code:` forms) run on your own Claude Code, which signs its own
  requests. A cached Claude session accepts only the unchanged history and
  its actual preceding answer. Concurrent requests with the same cache key
  run in order; identical retries reuse the recorded answer. Cancelling a
  one-turn request interrupts Claude Code and closes it within the configured
  interrupt deadline even if it stops responding.
  With no `AI_GATEWAY_API_KEY` the completion judge runs on the subscription
  too: Claude Haiku on your Claude Code when it is signed in, otherwise GPT-6
  Luna on the Codex login when `SMITHERS_OPENAI_AUTH=chatgpt` is set.
  Team hosts use connected accounts through the existing account pool.
  No provider API key or gateway key is required; a failed subscription never
  falls back to an API key.

## Runners

The shebang in `bin/smithers.mjs` pins Node, because the durable engine is
not supported on Bun. Running the CLI with `bun --bun` overrides the shebang
and is not supported.

## The terminal UI

`smthrs tui` opens the terminal coding agent in the current directory. It
runs on Node 26.4 or later or on Bun. Under Node, the CLI starts the TUI with
`--experimental-ffi`, which OpenTUI needs to load its renderer. Set
`SMITHERS_BUN` to a Bun executable to run the TUI on Bun instead. The launcher
tries `SMITHERS_TUI_BIN`, an installed compiled binary, Bun, then Node.
Interactive startup in compiled builds loads the OpenTUI shared library from a writable, executable `TMPDIR`. If `/tmp` is mounted `noexec`, loading it can fail with `Operation not permitted`. Alpine also needs `libstdc++`.

If your home filesystem allows execution:

```bash
mkdir -p "$HOME/.cache/smithers/tmp"
export TMPDIR="$HOME/.cache/smithers/tmp"
smthrs tui /path/to/project
```

`--help` and `--print` do not load OpenTUI, so their success does not verify interactive startup. Launch without either flag in a terminal to check it.

The CLI package ships its native editor; keep the package intact when moving
a Node installation. Compiled binaries embed the editor. Installation does not
require Zig.

```bash
smthrs tui                       # open the TUI here
smthrs tui ../repo -c            # continue the latest conversation in ../repo
smthrs tui -m openai:gpt-6-sol   # choose the chat model
smthrs tui -p "Summarize README" # print one answer and exit
smthrs tui --approve ask        # ask before consequential calls
```

## Workspace target commands

Global and one-off installations can initialize a project and operate its flows.
To load `WORKSPACE.ts` and `PACKAGE.ts`, install the CLI and the declaration
package in that workspace, then run its local copy:

```bash
npm install --save-dev @smthrs/cli@next @smthrs/targets@next
npx smthrs init hello
npx smthrs targets
```

The loader and declarations must resolve the same physical Effect and Smithers
packages. The CLI and authoring packages require exactly `effect@4.0.5`. Your application
must use the same version. A wider supported range is tracked in
[#4238](https://github.com/smithersai/smithers/issues/4238). A separately
installed global CLI reports `declaration_dependency_mismatch` even when
versions match. The
[first-target tutorial](https://github.com/smithersai/smithers/blob/main/packages/smithers/build/docs/getting-started/first-build.md) walks
through local planning, execution, and cache reuse.

## Using the library

The package is also importable. The root entry point re-exports every module
as a namespace:

```ts
import { Command, NodeControl, Output, Verb } from "@smthrs/cli"
```

Each module is also importable from its own subpath, which is the form the
[API reference](./api.md) uses:

```ts
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Verb from "@smthrs/cli/Verb"
```

`@smthrs/cli/package.json` is exported. Two subpath forms are not public and
are blocked in the export map: `@smthrs/cli/internal/*` and
`@smthrs/cli/*/index`.

The package depends on the whole Smithers stack, including
[`@smthrs/control`](../control/docs/api.md), [`@smthrs/engine`](../flows/engine/docs/api.md),
[`@smthrs/agent`](../agent/docs/api.md), [`@smthrs/gateway`](../gateway/docs/api.md), and
[`@smthrs/journal`](../flows/journal/docs/api.md). Installing it installs them, so a host that
embeds the command tree adds no further packages. See
[Embed the command tree](./guides/embed-the-command-tree.md).

## Next step

[Change your code with a flow](./guides/change-code.md), review the diff, and commit and push it yourself.

Run one project from `init` to a settled run in the [Quickstart](./quickstart.md).

## Agent skill

Run `smthrs skills add` to install or refresh the packaged Smithers authoring skill in detected agents. The skill comes from the installed CLI package, regardless of your current directory.
Global sync also removes the old generated `smthrs-create-app` skill, including
installs whose original sync metadata is missing. Custom skills are preserved.
