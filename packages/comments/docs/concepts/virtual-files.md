---
title: "Smithers Virtual Files"
description: "Project external comments back into source files via VirtualFileTree and Smithers Generate, Overlay, and Materialize targets."
---

# Smithers Virtual Files

In `external` mode, your real source files stay free of prose comments while `.comments/` holds the anchored explanations. Whenever a human, documentation generator, static analyzer, or AI reviewer wants to view or build against commented files, Smithers Comments projects a **virtual file tree** without modifying your working copy.

## How virtual projection works

Given a clean source file `S` and its parsed sidecar document `C`, `VirtualFile.projectFile(source, sidecar, language)` computes a `VirtualFile`:

```ts
interface VirtualFile {
  readonly path: string // repository-relative POSIX path, e.g. "src/auth/token.ts"
  readonly content: string // rendered source text with comments woven in
  readonly digest: string // SHA-256 hex digest of content
  readonly sourceDigest: string // SHA-256 hex digest of clean source
  readonly commentsDigest: string // SHA-256 hex digest of canonical sidecar (or empty string if none)
  readonly injectedCount: number // number of comment blocks woven into content
  readonly lineMap: ReadonlyArray<{
    readonly commentId: string
    readonly virtualStartLine: number
    readonly virtualEndLine: number
    readonly anchorLine: number
  }>
}
```

### Projection rules

1. **Line endings**: The projected file preserves the original source file's dominant line ending (`\r\n` if CRLF, otherwise `\n`) and trailing newline state.
2. **Indentation matching**: For `before` and `after` placements, every line of the rendered comment inherits the exact leading whitespace (spaces or tabs) of the target anchor line.
3. **Comment syntax by language and style**:
   - **C-family** (`.ts`, `.tsx`, `.js`, `.go`, `.rs`, `.c`, `.cpp`, `.java`, `.zig`, `.sol`, `.vibe`, etc.):
     - `line`: `// <line>` per line (or trailing `// <line>` for `inline` placement)
     - `block`: `/* <single-line> */` or multi-line `/*\n * ...\n */`
     - `doc`: `/**\n * ...\n */`
   - **Hash-family** (`.py`, `.sh`, `.rb`, `.yaml`, `.toml`):
     - `line` / `block` / `doc`: `# <line>` per line (or trailing `# <line>` for `inline`)
   - **Dash-family** (`.sql`, `.lua`, `.hs`):
     - `line` / `block` / `doc`: `-- <line>` per line (or trailing `-- <line>` for `inline`)
   - **Markup-family** (`.html`, `.xml`, `.svg`):
     - `line` / `block` / `doc`: `<!-- <text> -->`
4. **Multiple comments on the same anchor**: Sorted deterministically by `(placementOrder, id)` where `before` comes above the line, `inline` appends to the end of the line (single-line comments only; multi-line `inline` comments fall back to `before` with a warning diagnostic), and `after` goes immediately below the line.
5. **Pragma preservation**: Leading shebang (`#!...`) and SPDX license lines stay at the top of the file; `file`-anchored `before` comments are inserted immediately below them.
6. **Unresolved anchors**: If any anchor fails to resolve, projection fails with a typed `VirtualFileProjectionError` naming the file, comment ID, and failure reason (`dangling-anchor` or `ambiguous-anchor`), unless `onUnresolved: "skip"` is explicitly passed.

### Tree projection

`VirtualFile.projectTree(files, sidecars)` returns a `VirtualFileTree`:

```ts
interface VirtualFileTree {
  readonly files: ReadonlyMap<string, VirtualFile>
  readonly treeDigest: string // SHA-256 over sorted `${path}:${digest}\n` entries
}
```

Because `treeDigest` depends only on the exact content of the source files and their sidecars, downstream Smithers build targets automatically reuse cached results whenever neither the source nor its comments changed.

## Wiring into Smithers targets (`PACKAGE.ts`)

`smithers-comments` exports `targets(...)` built directly on `@smthrs/targets` (`Smithers.Filegroup`, `Smithers.Generate`, `Smithers.Overlay`, `Smithers.Materialize`, and `Smithers.Shell.Test`):

```ts
import { Smithers } from "@smthrs/targets"
import { targets } from "smithers-comments"

const comments = targets({
  mode: "external",
  commentsDir: ".comments",
  include: ["src/**/*.ts"],
  virtualOutDir: ".smithers/comments-view"
})

export const Package = Smithers.Package({
  targets: {
    commentsSources: comments.sources,
    commentsSidecars: comments.sidecars,
    commentsLint: comments.lint,
    commentsVirtual: comments.virtualFiles,
    commentsMaterialize: comments.materialize
  }
})
```

What each returned Smithers target does:

| Target         | Underlying Smithers primitive | Behavior                                                                                              |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `sources`      | `Smithers.Filegroup`          | Tracks all managed source files via `include` / `exclude` globs.                                      |
| `sidecars`     | `Smithers.Filegroup`          | Tracks all `<commentsDir>/**/*.md` sidecars.                                                          |
| `lint`         | `Smithers.Shell.Test`         | Runs `smithers-comments check` incrementally; cached on `sources`, `sidecars`, and config.            |
| `virtualFiles` | `Smithers.Generate`           | Emits the commented virtual files into `virtualOutDir` via the `render` workflow; cached by Smithers. |
| `materialize`  | `Smithers.Materialize`        | Places `virtualFiles`'s cached output tree into the working tree on demand.                           |

You can also compose `Smithers.Overlay` directly when you want a downstream target (such as documentation generation or code review) to consume selected projected files without writing them over your real sources.

## CLI materialization

Outside `PACKAGE.ts`, project virtual files directly from the CLI:

```sh
# Inspect one projected file on stdout
smithers-comments render --file src/auth/token.ts

# Write the virtual file tree to an output folder
smithers-comments render --out .smithers/comments-view

# Verify an existing materialized folder has zero drift
smithers-comments render --out .smithers/comments-view --check
```
