---
title: "Repositories"
description: "Which CI sources and languages smithers-ci reads, the repositories it is built on, and what it does not run."
---

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
language. TypeScript and Zig each have one; another language adds its own, with
the same shape. A closure with an import its strategy cannot
follow is affected by every change, so its target always runs: a gap makes
Smithers CI slower, never wrong.

## The repositories it is built on

| Repository           | Language   | CI driven by                              |
| -------------------- | ---------- | ----------------------------------------- |
| Smithers             | TypeScript | GitHub Actions running Smithers build     |
| VibeLang             | TypeScript | Smithers build                            |
| `refcell/needlefish` | Zig        | A Justfile; no GitHub workflows           |
| `elizaOS/eliza`      | TypeScript | Bun, Turborepo, about 40 GitHub workflows |

## What it does not run

- **Steps with no command.** A hosted service container, or a third-party
  GitHub Action that runs no shell command, is listed in the inventory as
  unsupported, with the reason.

When the repository depends on something Smithers CI cannot run, the command
stops with exit code 3 and names it. `smithers-ci inventory` shows what was
read and what was marked unsupported, without replaying anything: under each
job what stops it, and at the top each file that could not be read, such as a
workflow that does not parse.
