---
title: "Set the commands that verify each unit"
description: "How the tool derives install, format, typecheck, and test commands from your project, and how to replace any of them when the derivation is wrong."
sidebar:
  order: 4
---

Every unit is verified before it is accepted, with four kinds of command plus
registry discovery. The tool derives them from your project. When the
derivation is wrong, an override is the only way to correct it, because the
orchestrator runs these commands after the model answers.

`--apply` runs the project's own install, format, typecheck, and test commands
on your machine, package manager lifecycle scripts and `repoCommands.test`
included. Each command runs in the host's process sandbox, described under
[what a verification command can reach](#what-a-verification-command-can-reach).
The sandbox leaves the network open and the project's source readable, so
run it only on a trusted checkout or inside a sandbox.

## What the derivation produces

| Kind      | Derived from                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Install   | The `packageManager` field, else the lockfile: `bun install`, `pnpm install`, `yarn install`, or `npm install`.           |
| Format    | `dprint check` when the project has a `dprint.json`, else `prettier --check .` when it configures prettier.               |
| Typecheck | One `tsc --noEmit -p <path>` per `tsconfig.json`, excluding `tsconfig.test.json`, sorted by path.                         |
| Test      | `repoCommands.test` from `smithers.config.ts`, else the root `test` script run through the project's package manager.     |
| Discovery | The registry's own discovery scan over the flows directory. Not overridable: confirms the registry can discover the flow. |

The formatter runs in check mode on purpose. A verification asks a question,
and a formatter that rewrites the repository answers it by editing files the
unit does not own.

## What a verification command can reach

The rewrite agent edits `package.json`, test files, and tool configuration, so
an unchanged `npm install` or `npm run test` executes text the agent wrote.
Every verification command, derived or overridden, therefore starts in the
host's process sandbox: bubblewrap on Linux, seatbelt on macOS.

| Resource    | What the command gets                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reads       | The project, the system toolchain directories, every directory on your `PATH`, and the install root of each runtime and package manager `PATH` resolves. Not the rest of your home directory. Not a dotenv file. |
| Writes      | The project, except `.git`, `.jj`, `.smithers-migrate`, the `--report-dir` directory, and dotenv files. Nothing outside the project.                                                                             |
| Environment | `PATH`, `HOME`, `USER`, `LANG`, every `LC_*`, `TERM`, `TMPDIR`, and `SHELL`. `HOME` and `TMPDIR` point at a private directory removed after the command.                                                         |
| Network     | Open, because an install has to reach a registry. No Unix socket of the host.                                                                                                                                    |

The toolchain is chosen by the host from your own `PATH`, never from anything
the agent wrote. The runtimes and package managers it resolves are `node`,
`npm`, `npx`, `pnpm`, `pnpx`, `yarn`, `yarnpkg`, `bun`, `bunx`, and `corepack`,
so a toolchain a version manager installed under your home directory works: an
nvm Node, a corepack shim, a pnpm installed by its own script. A `PATH` entry
that is your home directory, a credential directory such as `~/.ssh`, or a
parent of the project is never opened.

A dotenv file is any file or directory whose name starts with `.env`, in any
case and at any depth: `.env`, `.env.local`, `packages/api/.ENV`. A command can
neither read nor write one, so a lifecycle script cannot send your keys over
the open network. These are the names the agent is denied too. On Linux the
tool finds them before each command, in `node_modules` as well; a directory it
cannot list stops the command, because a dotenv file it cannot find is one it
cannot hide.

A version manager that starts tools through a shim (Volta, asdf, mise) keeps
the real runtime outside `PATH`, and the sandbox does not find it. Put the
runtime's own `bin` directory on `PATH` before you start the tool.

Six consequences follow:

- A token in your shell or in `~/.npmrc` does not reach an install. A private
  registry needs a project-level configuration the command can read.
- A package manager's cache under your home directory is not used.
- A test that loads `.env` finds it empty on Linux and unreadable on macOS.
- A tool that listens on a named Unix socket fails. Processes the command
  starts can still talk to each other over inherited socket pairs, which is
  what pnpm and Node use.
- A command that creates `.git` or `.jj` in a project that had none fails the
  verification, and the tool removes what the command created: a checkpoint
  would otherwise run what that configuration names, as you.
- The tool's own checkpoint `git` commands start no hook and no filesystem
  monitor, since a project file can name either.

### Open more to the sandbox

`--verify-read <path>` opens one more path for reading. It is repeatable, and a
relative path resolves from the project root.

```bash
smithers-migrate --apply --seat anthropic:<model> \
  --verify-read .env.test \
  --verify-read /opt/company/registry-settings
```

A path outside the project is opened read-only. A path inside the project
reopens, for reading, the dotenv files at or below it: `--verify-read .env.test`
gives the tests that one file, and `--verify-read packages/api` gives them
every dotenv file in that package. Nothing else about the sandbox changes.

The tool resolves each path once, before the first unit, and a command cannot
write to a path inside the project that you opened. If a path later names a
different file or directory, the commands that follow are refused.

### Hosts with no sandbox

Windows has no process sandbox, and Linux has one only when `bwrap` is on
`PATH`. On such a host `--apply` refuses with `no-sandbox` and exit 1 before
any unit runs, and edits nothing. It never falls back to running the commands
unconfined. See [Troubleshooting](../troubleshooting.md#no-sandbox).

`--verify-unconfined` is the explicit opt-out:

```bash
smithers-migrate --apply --seat anthropic:<model> --verify-unconfined
```

The commands then run with your own privileges, your whole environment, and
every file you can read, and the tool prints a warning that says so before it
starts. Use it only where the machine itself is disposable: a container, a CI
runner, a virtual machine.

## Required declaration checks

Before archiving an old workflow, migration also checks that its replacement
uses `export default Flow.make("<tag>", { description: "...", payload: {}, body: ... })`.
The tag must be a nonempty literal. A payload schema or field object (including
`{}` for no input) and a body are required. Legacy
object-first declarations and `model` or `flows` without a body fail even when
the project has no typecheck command. Failed replacements leave the original
source in place and record the failed check in the migration report.

These static checks do not execute generated code or prove its behavior.
Use the project's typecheck and tests to verify the implementation.

## Override any of them

```bash
smithers-migrate --apply --seat anthropic:<model> \
  --verify-install "pnpm install --frozen-lockfile" \
  --verify-format "make fmt-check" \
  --verify-typecheck "make typecheck" \
  --verify-test "make test"
```

`--verify-typecheck` is repeatable, once per command you want run:

```bash
smithers-migrate --verify-typecheck "tsc -p tsconfig.build.json" --verify-typecheck "tsc -p tsconfig.app.json"
```

One empty value runs no typecheck at all:

```bash
smithers-migrate --verify-typecheck ""
```

These flags matter more than convenience. A project whose typecheck lives in a
Makefile has no other way to be migrated, because every unit is verified with
these lines after the model answers. The model has no shell or verification tool.

## Derived commands get no shell

A derived command is an argv value: an executable and its literal arguments,
spawned with no shell in between. A tsconfig named `tsconfig.;rm -rf .json` is
one argument to `tsc`, not a line a shell reads.

An override is a string, and it keeps shell semantics, because you typed it.
That is the only place shell syntax is honored.

`smithers.config.ts`'s `repoCommands.test` is repository text, not operator
text, so it is accepted only when it is a plain line of words: no quotes, no
`$`, `;`, `|`, `&`, redirection, glob, or newline, and an executable that is
not a flag. A line the tool refuses is reported in the plan's notes, naming the
command that ran instead and the exact `--verify-test` value that runs the line
as written.

## Verification belongs to the host

The same derivation builds the command list shown to the model and recorded
in the report. The orchestrator runs those exact commands after each rewrite
and returns failures for repair. Agents edit through guarded filesystem flows;
no shell or `migrate/verify` tool is offered. Operator overrides keep their
shell syntax, including literal wildcard characters.

## Bounded output

Each verification command's streams keep their last 12 KB through a rolling
window, and the report says how many earlier bytes were dropped. The captured
output passes through the journal's shared redaction rules before it reaches
`report.json`; see
[The migration report](../concepts/report.md).
