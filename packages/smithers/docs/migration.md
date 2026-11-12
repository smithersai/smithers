---
title: "Upgrade from 0.x to 1.0"
description: "What Smithers 1.0 removes, how smthrs migrate plans and applies the source migration, what its report means, and how to choose a seat for a CLI subprocess agent."
---

Smithers 1.0 is a source migration, not a version bump. `smthrs migrate` reads
a 0.x project, writes a report, and changes source only when you pass
`--apply`.

## What 1.0 removes

| Removed in 1.0                                                                                                                                         | What you use instead                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| The `smthrs` umbrella import. `smthrs@1.0` exports nothing: `import "smthrs"` throws a notice, and `import { Workflow } from "smthrs"` fails to link. | The `@smthrs/*` packages. `@smthrs/flows` holds authoring and the engine. `@smthrs/cli` holds the `smthrs` command.                    |
| JSX authoring. 1.0 publishes no `jsx-runtime`, so a `.tsx` workflow no longer compiles.                                                                | `.smithers/flows/<name>/flow.ts`, which default-exports `Flow.make`. A task becomes `Action.make`, or `AgentAction.make` when a model runs it. |
| The `<UI>` element.                                                                                                                                    | Nothing. Remove the element and keep the UI source file.                                                                                |
| 0.x run databases. 1.0 does not load, resume, or migrate them.                                                                                         | Nothing. Finish, archive, or discard 0.x runs first. See [Run data](#run-data).                                                         |

## Plan the migration

Run the plan in the 0.x project directory. It needs no provider key:

```bash
npx smthrs@next migrate
```

The plan writes `.smithers-migrate/report.md` and
`.smithers-migrate/report.json` and changes nothing else. Add `--scan` to print
the same inventory and write nothing.

Keep `@next`. npm's `latest` tag stays on `smthrs@0.35.0` until 1.0.0 is final,
so `npx smthrs migrate` runs 0.x.

## Read the report

The summary at the top of `report.md` counts what the plan found:

| Field            | What it counts                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Run state        | `clean`, `history-only`, or `blocked`. See [Run data](#run-data).                                                                           |
| Workflow files   | The 0.x workflow sources. Each becomes one `.smithers/flows/<name>/flow.ts`.                                                                          |
| Constructs found | Every use of a 0.x API. Construct inventory lists each with its file and line, and Mapping decisions names its 1.0 target.                 |
| Units            | The steps `--apply` runs in order: `dependencies`, one `workflow:<name>` per workflow file, then `project`.                                 |
| Unresolved       | Decisions the tool leaves to you. Each CLI subprocess agent is one. See [Choose a seat](#choose-a-seat-for-a-cli-subprocess-agent).        |
| Unsupported      | Constructs with no 1.0 counterpart, such as `<UI>`.                                                                                         |

A unit in a plan is `planned` or `blocked`. A blocked unit holds an unsupported
construct. `--apply` exits 3 without touching the project until you name each
one with `--allow-unsafe <construct>`, or `--allow-unsafe all`. The rewrite then
leaves a `TODO(migrate-smithers-v1)` marker where the construct was.

Manual follow-ups, the last section, is the checklist. A `must` item stops the
migration: run state, an unsupported construct, a blocked or failed unit. A
`should` item is an unresolved decision.

## Run data

1.0 does not load, resume, or migrate a 0.x run database. Two messages link to
this section.

A 1.0 command run in a project that holds 0.x state prints one notice on stderr
and continues:

```text
Found Smithers 0.x state at <path>. <version> does not load, resume, or migrate 0.x run databases.
```

`smthrs migrate` exits 1 when a `smithers.db` beside the project holds runs
that have not finished, or cannot be opened:

```text
Refusing to migrate: this project still holds Smithers 0.x run state.
```

The refusal lists each run. No flag releases it. List the runs with the 0.x
CLI, finish, archive, or discard them, then run the command again:

```bash
bunx smthrs@0.35.0 ps
```

Finished runs do not stop the plan. When the report's run state is not `clean`,
`--apply` exits 3 until you follow the instructions the report prints under
Run state, or pass `--acknowledge-run-state`.

## Choose a seat for a CLI subprocess agent

In 0.x, `ClaudeCodeAgent`, `CodexAgent`, and `OpenCodeAgent` ran a vendor CLI
on your own subscription. No seat in the source names that, so the report lists
each use as unresolved, with its file and line.

In 1.0 an agent step names a seat: the `seat` of `AgentAction.make`, or `model:`
in a `flow.mdx`. The `smthrs` CLI resolves these seats:

| 0.x agent         | Keep the subscription                                                                                            | Or pay per call                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ClaudeCodeAgent` | `claude-code:<model>`, such as `claude-code:opus`. Run `claude auth login` and leave `ANTHROPIC_API_KEY` unset. | `anthropic:<model>` with `ANTHROPIC_API_KEY`.                                                                                                |
| `CodexAgent`      | `codex:<model>`, such as `codex:sol`. Run `codex login --device-auth`.                                           | `openai:<model>` with `OPENAI_API_KEY`.                                                                                                      |
| `OpenCodeAgent`   | No seat. 1.0 does not run OpenCode.                                                                              | The provider your OpenCode agent called: `anthropic:<model>`, `openai:<model>`, or `openrouter:<vendor>/<model>` with `OPENROUTER_API_KEY`. |

A `fallbackAgents` pool stays a pool. The report records its members and never
picks the first one for you.

## Apply

`--apply` rewrites the source one unit at a time with a model. Name the seat
that does the rewriting and set that provider's key:

```bash
ANTHROPIC_API_KEY=<key> npx smthrs@next migrate --apply --seat anthropic:<model>
```

`--seat` takes an `anthropic:`, `openai:`, or `openrouter:` seat, with
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`.

Commit first. Apply checkpoints each unit before it edits, and refuses a
project under no version control unless you pass `--allow-no-vcs`. It runs your
project's own install, format, typecheck, and test commands, so run it on a
checkout you trust. Each of those commands runs in the host's process sandbox
(bubblewrap on Linux, seatbelt on macOS): it gets the project and your
toolchain, and not your home directory, your environment, or a dotenv file.
`--verify-read <path>` opens one more path for reading. A host with no sandbox
refuses `--apply` until you install one or pass `--verify-unconfined`, which
runs the commands with your own privileges and prints a warning.

| Exit | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| `0`  | Every planned unit migrated.                                                                         |
| `1`  | A unit failed and was restored from its checkpoint, or `smthrs migrate` refused unfinished 0.x runs. |
| `3`  | Apply stopped at a decision: run state, an unsupported construct, or another apply in progress.      |

Units, checkpoints, and every flag are in the
[`@smthrs/migrate` docs](https://github.com/smithersai/smithers/tree/main/packages/smithers/migrate/docs).

## Removed commands and flags

A removed 0.x command or flag exits 1 with one sentence that names what
replaced it, never a usage error.

<!-- generated:removed-commands -->
