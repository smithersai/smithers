---
title: "Installation"
description: "Install the smthrs CLI from npm, verify prerequisites, connect Codex or Claude subscriptions, run the TUI, or import @smthrs/cli as a library."
sidebar:
  order: 1
---

## Install the CLI

The 1.0 release candidate ships on npm under `@next` (`latest` remains on 0.35.0).

**Prerequisites:**
- **Node.js 22.19.0 or later.** Download from [nodejs.org](https://nodejs.org/en/download) (on Apple Silicon Macs, choose macOS ARM64), open a new terminal, and verify with `node --version`.
- **[Jujutsu](https://jj-vcs.github.io/jj/latest/install-and-setup/) (`jj`)** for repository diffs and operations, plus **`jq`** for JSON pipelines.

On macOS with [Homebrew](https://brew.sh/):

```bash
brew install jj jq
```

Install `smthrs` globally and check the installed version:

```bash
npm install -g smthrs@next
smthrs --version
```

`smthrs` installs both the `smthrs` command and its `smithers` alias, pulling `@smthrs/cli` and `@smthrs/platform-node` (including the prebuilt `smithers-jj-export` helper) automatically. Do not install both `smthrs` and `@smthrs/cli` globally; npm rejects the duplicate binary link.

> **Running target commands (`WORKSPACE.ts` / `PACKAGE.ts`)?** Install the CLI locally inside that workspace so declarations and loader share one physical Effect and Smithers installation; see [Workspace target commands](#workspace-target-commands).

## Verify and update

```bash
smthrs doctor
```

`doctor` checks flow discovery, database compatibility, Node.js version, `jj`, and provider configuration without launching any flow. It exits `1` on any failure.

To check for newer releases or upgrade:

```bash
smthrs update                  # read-only check against npm next/latest tags (prefers next)
npm install -g smthrs@next     # install the newest release candidate
```

### Runtime dependencies

The CLI selects `effect@4.0.5` via peer dependency and installs `@effect/sql-sqlite-node@4.0.5` for default local SQLite persistence (`@smthrs/database` itself keeps SQLite optional). For PostgreSQL, add the optional `@effect/sql-pg@4.0.5` adapter.

## Requirements

- **Node.js 22.19.0 or later:** enforced by `Doctor.supportedNodeRange` and the published `engines` field.
- **Project directory:** stateful commands resolve the project root and store durable state in `.flows/`. See [The project and its state](./concepts/project-and-state.md).
- **Model seat (subscription or API key):**

| Provider | Setup command | Seat names | Behavior |
| --- | --- | --- | --- |
| **Codex (ChatGPT login)** | `codex login --device-auth` + `export SMITHERS_OPENAI_AUTH=chatgpt` | `codex:sol` or `openai:*` | Reads `$CODEX_HOME/auth.json` (`~/.codex/auth.json`) read-only, stamps the run cache key as session ID, and asks the Codex CLI to refresh expiring tokens (coordinated via `auth.json.refresh.guard.sqlite`; keep that empty guard file intact while Smithers runs). |
| **Claude (Claude Code login)** | `claude auth login` (with `ANTHROPIC_API_KEY` unset) | `opus`, `sonnet`, `fable`, `claude-code:*` | Routes through your local Claude Code process. Reuses cached sessions only for identical history, serializes same-key concurrent calls, and interrupts cleanly on cancellation. |
| **Completion judge** | Optional `AI_GATEWAY_API_KEY` | Automatic | Uses Jev when `AI_GATEWAY_API_KEY` is set; otherwise falls back to Claude Haiku on signed-in Claude Code, then GPT-6 Luna on Codex (`SMITHERS_OPENAI_AUTH=chatgpt`). Team hosts use their connected account pool. |

No provider API key is required when using a subscription, and a failed subscription never silently falls back to an API key.

## Runners

The shebang in `bin/smithers.mjs` pins **Node.js**, because the CLI's durable engine is not supported under Bun. Do not override the shebang with `bun --bun`.

## The terminal UI

`smthrs tui` opens the interactive terminal coding agent on Node 26.4+ (launched with `--experimental-ffi` for OpenTUI) or on Bun (`SMITHERS_BUN=/path/to/bun`). Launcher precedence: `SMITHERS_TUI_BIN` -> compiled binary -> Bun -> Node.

The CLI ships its native editor bundled (no Zig required); keep the Node package directory intact when relocating an install.

```bash
smthrs tui                       # open the TUI in the current directory
smthrs tui ../repo -c            # resume the latest conversation in ../repo
smthrs tui -m openai:gpt-6-sol   # select a specific chat model
smthrs tui -p "Summarize README" # print one answer and exit
smthrs tui --approve ask         # prompt before consequential calls
```

> **Linux `/tmp` mounted `noexec`?** Compiled builds load OpenTUI from `TMPDIR` and fail with `Operation not permitted` on `noexec` mounts (Alpine also needs `libstdc++`). Point `TMPDIR` at an executable directory and verify interactively (`--help` and `--print` do not load OpenTUI):
> ```bash
> mkdir -p "$HOME/.cache/smithers/tmp"
> export TMPDIR="$HOME/.cache/smithers/tmp"
> smthrs tui /path/to/project
> ```

## Workspace target commands

Target commands (`smthrs targets`, `build`, `test`, `lint`, `ci`) evaluate `WORKSPACE.ts` and `PACKAGE.ts`, which must resolve the exact same physical `effect@4.0.5` and Smithers packages as the CLI (wider Effect ranges are tracked in [#4238](https://github.com/smithersai/smithers/issues/4238)). A separate global CLI fails with `declaration_dependency_mismatch` even when version numbers match.

Install locally in the workspace:

```bash
npm install --save-dev @smthrs/cli@next @smthrs/targets@next
npx smthrs init hello
npx smthrs targets
```

See the [first-target tutorial](https://github.com/smithersai/smithers/blob/main/packages/smithers/build/docs/getting-started/first-build.md) for planning, execution, and cache reuse.

## Using the library

`@smthrs/cli` is importable both from its root entry point and by individual module subpath (matching the [API reference](./api.md)):

```ts
import { Command, NodeControl, Output, Verb } from "@smthrs/cli"
```

```ts
import * as NodeControl from "@smthrs/cli/NodeControl"
import * as Verb from "@smthrs/cli/Verb"
```

`@smthrs/cli/package.json` is exported; `@smthrs/cli/internal/*` and `@smthrs/cli/*/index` are blocked by the export map.

Installing `@smthrs/cli` brings in the underlying stack ([`@smthrs/control`](../control/docs/api.md), [`@smthrs/engine`](../flows/engine/docs/api.md), [`@smthrs/agent`](../agent/docs/api.md), [`@smthrs/gateway`](../gateway/docs/api.md), [`@smthrs/journal`](../flows/journal/docs/api.md)), so embedding hosts need no extra packages. See [Embed the command tree](./guides/embed-the-command-tree.md).

## Agent skill

Run `smthrs skills add` from any directory to install or refresh the packaged Smithers authoring skill in detected coding agents.

## Next steps

- [Change your code with a flow](./guides/change-code.md): run a coding agent locally, inspect the diff, and push yourself.
- [Quickstart](./quickstart.md): walk the full `init -> plan -> approve -> execute` loop.
