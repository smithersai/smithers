---
title: "Quickstart"
description: "Validate inline comments, move comments to .comments/, and generate commented virtual files."
---

# Quickstart

## Prerequisites

- Node.js 22.19 or later (Node 26 recommended).
- An existing repository directory.

## Inline mode (zero config)

Run `check` inside any repository. Without a configuration file, Smithers Comments defaults to `inline` mode:

```sh
bunx smithers-comments check
```

What `check` does:

1. Discovers source files matching the configured include globs (excluding `node_modules`, `.git`, `dist`, and `.comments`).
2. Lexes every comment without touching strings, regex literals, or compiler pragmas.
3. Runs deterministic structural checks (empty comments, broken `@ref` references, malformed JSDoc tags, policy rules).
4. Runs cached semantic validation via a Smithers flow. Each comment is keyed by `sha256(path, commentBody, anchoredCodeRegion, rubric)`. Unchanged comments are cache hits and make zero agent calls.

Example output:

```text
smithers-comments check (mode: inline)
  files: 12  comments: 34  diagnostics: 0
  cache: 34 hits, 0 misses (0 agent calls)
```

When a comment fails validation, `check` prints each diagnostic with its file, line, rule code, and message, and exits with code `1`:

```text
src/auth/token.ts:14  error  [stale-comment]  Comment claims tokens expire in 1 hour, but TOKEN_TTL_SECONDS is 900 (15 minutes).
smithers-comments check (mode: inline)
  files: 12  comments: 34  diagnostics: 1
  cache: 33 hits, 1 miss (1 agent call)
```

To repair stale or invalid comments automatically through the Smithers fix workflow:

```sh
bunx smithers-comments fix --dry-run
bunx smithers-comments fix
```

## External mode

To move prose comments out of your source code and into `.comments/` (or any custom folder such as `.notes`):

```sh
bunx smithers-comments init --mode external --dir .comments
bunx smithers-comments extract
```

`extract` does three things atomically per file:

1. Parses every comment in your source files.
2. Keeps compiler, linter, shebang, and license pragmas inside the source file.
3. Strips prose comments from the source file and writes canonical sidecar files under `.comments/<relative-source-path>.md`, anchored by symbol name, line number, and a `code-hash` of the anchored code region.

Verify the repository in external mode:

```sh
bunx smithers-comments check
```

In external mode, `check` verifies:

- No stray non-pragma comments were left in source files (when `strictExternal` is `true`, the default).
- Every sidecar file in `.comments/` parses cleanly and points to an existing source file.
- Every comment anchor resolves cleanly and its `code-hash` matches (or passes cached semantic validation).
- Virtual file projection succeeds with zero anchor conflicts.

## Generating commented virtual files

When you want to read, review, publish docs from, or pass commented source files to downstream tools without dirtying your working tree:

```sh
# Print one virtual commented file to stdout
bunx smithers-comments render --file src/auth/token.ts

# Materialize the entire virtual commented tree into a directory
bunx smithers-comments render --out .smithers/comments-view

# Or switch back to inline mode by writing comments back into source files
bunx smithers-comments render --in-place
```

In a Smithers workspace, wire virtual files and incremental comment checks directly into `PACKAGE.ts`:

```ts
import { Smithers } from "@smthrs/targets"
import { targets } from "smithers-comments"

const comments = targets({
  mode: "external",
  commentsDir: ".comments",
  include: ["src/**/*.ts"]
})

export const Package = Smithers.Package({
  targets: {
    commentsLint: comments.lint,
    commentsVirtual: comments.virtualFiles,
    commentsMaterialize: comments.materialize
  }
})
```

## What Smithers Comments never touches

- `check` and `status` never modify source files or sidecar files.
- `render --file` and `render --out <dir>` never modify source files.
- `extract` never removes pragmas (shebangs, `SPDX-License-Identifier`, `@ts-expect-error`, `eslint-disable`, `go:generate`, `noqa`, and others listed in [Modes](../concepts/modes.md)).
- Cache files live under `.smithers/` (never beside your source files).

## Next steps

- Read [Inline and External Modes](../concepts/modes.md).
- Inspect the [External Sidecar Format](../concepts/sidecar-format.md).
- Wire up [Smithers Virtual Files](../concepts/virtual-files.md).
