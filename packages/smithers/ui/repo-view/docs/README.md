---
title: "@smthrs/repo-view"
description: "The heavy views of a repository: the repository browser, a file highlighted by Shiki, a highlighted diff and the Milkdown Markdown editor, imported from one root and loaded lazily."
sidebar:
  order: 0
---

`@smthrs/repo-view` holds the views that need a heavy renderer. Each one is
exported from the package root.

| View             | Shows                                                             | Renderer                     |
| ---------------- | ----------------------------------------------------------------- | ---------------------------- |
| `RepoView`       | A repository's file tree, a directory with its README, or a file | The three below              |
| `CodeFileView`   | One file, syntax highlighted, with a language server's marks, hover card and keyboard cursor | `@pierre/diffs`, Shiki       |
| `SymbolsPane`    | A symbol's definitions and references, or a file's outline        | `@smthrs/ui`                 |
| `PierreDiffView` | A unified patch, syntax highlighted                               | `@pierre/diffs`, Shiki       |
| `MarkdownEditor` | A Markdown document, edited or read in place                      | Milkdown Crepe               |
| `CodeEditor`     | A file's text, edited by several people at once, with their carets | CodeMirror                   |
| `LiveMarkdownEditor` | A Markdown document several people edit at once                | Milkdown Crepe               |

The light pieces stay in `@smthrs/ui`: `FileTree`, `Breadcrumbs`,
`DirectoryListing`, the `Markdown` renderer, `DiffHunks` and `CodeBlock`.
Reach for this package when a page shows a whole repository, a highlighted
file or diff, or a document a person edits.

## Bundle cost

The package's entry carries `@smthrs/ui` and pierre's engine. Shiki's grammars and themes, the VibeLang grammar and
Milkdown are dynamic imports, so a bundler that splits chunks loads them only
when a view first needs them. `test/bundle.test.ts` builds the package the way
an app does and fails if any of them reaches the entry chunk.

Import the package from the module that renders a view, and load that module
lazily from the route that needs it. See
[Use the repository views](./guides/use-the-repository-views.md).

## Styles

Every view injects the package's sheet (`repoViewCss`) once, in the browser.
Render `<RepoViewStyles />` once beside `@smthrs/ui`'s `<SmithersUiStyles />`
when you render on a server. `MarkdownEditor` ships its own sheet through
`MarkdownEditorStyles`.

File Markdown previews grow below their toolbar. Through 960px, preview mode
controls have at least 32px tap targets.

## Pages

- [Use the repository views](./guides/use-the-repository-views.md)
- [API reference](./api.md)
- [Failure codes](./reference/contracts.md)

Read-only Markdown preserves GitHub-style HTML paragraphs, emphasis, centered
preformatted logos, and safe links and images. Comments, executable elements,
styles, event attributes, and unsafe URL schemes are removed before nodes enter
the document. Editable Markdown retains its source.
