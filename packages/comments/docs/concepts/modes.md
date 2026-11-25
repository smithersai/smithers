---
title: "Inline and External Modes"
description: "How inline mode and external mode work, what pragmas stay in code, and how to switch between modes."
---

# Inline and External Modes

Smithers Comments supports exactly two modes: `inline` and `external`. Both modes share the same lexer, anchor resolver, structural linter, and Smithers cached agentic workflow.

## Inline mode

Set `"mode": "inline"` in `.smithers/comments.json` (or omit the config file altogether).

- Comments remain directly inside your source files.
- `smithers-comments check` parses all matching source files, binds each comment to its surrounding code region, runs deterministic structural rules, and executes cached semantic validation via Smithers flows.
- `smithers-comments fix` updates stale or broken inline comments in place (or previews diffs with `--dry-run`).
- Sidecar files in `commentsDir` are ignored unless you explicitly run `extract` or `render`.

Inline mode is ideal when your team prefers traditional comments in source files and wants continuous, low-cost, cached verification that comments never drift from implementation.

## External mode

Set `"mode": "external"` and `"commentsDir": ".comments"` (or any relative directory inside the repository, such as `"docs/comments"` or `".notes"`).

- Prose comments live outside source files, one sidecar per commented source file: `<commentsDir>/<relative-source-path>.md`.
- Source files stay clean of prose comments, keeping diffs tight and agent context windows focused on executable code.
- When `strictExternal` is `true` (the default in external mode), `check` reports a `stray-inline-comment` error if any non-pragma comment appears inside a managed source file.
- `smithers-comments render` and the Smithers `virtualFiles` target project source files plus sidecars into commented virtual files whenever humans, documentation generators, or code-review tools want to view code with comments woven back in.

## Pragma preservation

Compiler, type-checker, bundler, linter, formatter, coverage, license, and executable directives are **pragmas**, not prose comments.

When `preservePragmas` is `true` (the default):

- `extract` leaves pragmas untouched in the source file.
- `check` in `external` mode never flags pragmas as `stray-inline-comment`.
- `render` never duplicates pragmas that already exist in the source file.

Built-in pragma patterns matched by default:

| Category             | Matched patterns                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Shebang              | Line 1 starting with `#!`                                                                                                               |
| License              | `SPDX-License-Identifier:`, `Copyright`                                                                                                 |
| TypeScript / JS      | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `@ts-check`, `/// <reference`, `sourceMappingURL=`, `webpackChunkName`, `@vite-ignore` |
| Linters & formatters | `eslint-disable`, `eslint-enable`, `eslint-env`, `prettier-ignore`, `biome-ignore`, `dprint-ignore`, `oxlint-disable`                   |
| Coverage             | `v8 ignore`, `c8 ignore`, `istanbul ignore`, `pragma: no cover`                                                                         |
| Python               | `noqa`, `type: ignore`, `pyright:`, `mypy:`, `pylint:`, `fmt: off`, `fmt: on`, `coding:`                                                |
| Go                   | `go:generate`, `go:embed`, `go:build`, `+build`, `nolint`                                                                               |
| Rust                 | `clippy::`, `rustfmt::skip`                                                                                                             |
| Regions              | `#region`, `#endregion`, `region`, `endregion`                                                                                          |

Additional custom pragma regular expressions can be added via `extraPragmaPatterns` in `.smithers/comments.json`.

## Switching modes

Switching between modes is lossless for all prose comments and pragmas:

### Inline to External

```sh
smithers-comments init --mode external --dir .comments
smithers-comments extract
smithers-comments check
```

### External to Inline

```sh
smithers-comments render --in-place
smithers-comments init --mode inline
smithers-comments check
```

Pass `--remove-sidecars` to `render --in-place` to delete the external sidecar files after weaving comments back into the source files.
