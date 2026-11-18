---
title: "Repositories"
description: "Which CI sources and languages smithers-ci reads, the first four repositories it is built for, and what it cannot run yet."
---

## State on 2026-11-17

Smithers CI is in development. Its parts are being built against a fixed set of
documents, and no repository runs end to end yet. This page says what each part
is built to read, and what is known not to run.

## CI it reads

| Source         | Read from             |
| -------------- | --------------------- |
| GitHub Actions | `.github/workflows/*` |
| Justfile       | a `Justfile`          |
| Makefile       | a `Makefile`          |
| `package.json` | its `scripts`         |
| Turborepo      | `turbo.json`          |

Any other CI system, such as Jenkins, CircleCI or GitLab CI, is not read.

## Languages

A target's dependency closure, the files it reads, comes from one strategy per
language. The TypeScript strategy exists. Zig, Rust, Go and the rest each add
their own, with the same shape. A closure with an import its strategy cannot
follow is affected by every change, so its target always runs: a gap makes
Smithers CI slower, never wrong.

## The first four repositories

| Repository           | Language   | CI driven by                              |
| -------------------- | ---------- | ----------------------------------------- |
| Smithers             | TypeScript | GitHub Actions running Smithers build     |
| VibeLang             | TypeScript | Smithers build                            |
| `refcell/needlefish` | Zig        | A Justfile; no GitHub workflows           |
| `elizaOS/eliza`      | TypeScript | Bun, Turborepo, about 40 GitHub workflows |

## What it cannot run yet

- **Steps with no command.** A hosted service container, or a third-party
  GitHub Action that runs no shell command, is listed in the inventory as
  unsupported, with the reason.
- **Bun installs.** Smithers build installs with pnpm only today and refuses a
  Bun install; see [Install](../../../smithers/build/docs/concepts/install.md).

When the repository depends on something Smithers CI cannot run, the command
stops with exit code 3 and names it. `smithers-ci inventory` shows what was
read and what was marked unsupported, without replaying anything: under each
job what stops it, and at the top each file that could not be read, such as a
workflow that does not parse.
