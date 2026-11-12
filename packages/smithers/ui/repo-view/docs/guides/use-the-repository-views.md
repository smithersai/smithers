---
title: "Use the repository views"
description: "Load the views lazily, then show a repository, a patch, one file or a Markdown document, and check what landed in your first chunk."
---

Every view in this package carries a heavy renderer. This guide wires each one
and keeps its weight off your application's first paint.

Before you reach for one, check whether `@smthrs/ui` already covers the job:
`Markdown` renders a document, `DiffHunks` renders a plain diff and `CodeBlock`
renders fenced code, none of them with a heavy dependency.

## Load the module lazily

A view import is a chunk boundary. Put the view in a module of its own, import
that module lazily from the surface that needs it, and its renderer stays out
of your application's first paint. One module imports `@smthrs/repo-view`, and
the card that renders a change reaches it through `React.lazy`.

```tsx
import { lazy, Suspense } from "react"
import { Skeleton } from "@smthrs/ui"

const DiffSurface = lazy(() => import("./DiffSurface"))

export function ChangeCard({ patch }: { readonly patch: string }) {
  return (
    <Suspense fallback={<Skeleton />}>
      <DiffSurface patch={patch} />
    </Suspense>
  )
}
```

## Show a repository

`RepoView` fetches nothing. Pass the file list and the files you loaded, and
own the location: `href` builds every link and `onNavigate` takes a plain click
on one, so the same view serves a routed page and a conversation.

```tsx
import { RepoView, type RepoViewFile, type RepoViewLocation } from "@smthrs/repo-view"

export function RepositoryPage({ name, paths, location, file, go }: {
  readonly name: string
  readonly paths: ReadonlyArray<string>
  readonly location: RepoViewLocation
  readonly file: RepoViewFile | undefined
  readonly go: (location: RepoViewLocation) => void
}) {
  return (
    <RepoView
      name={name}
      tree={{ state: "ready", paths }}
      location={location}
      file={file}
      href={(to) => `/${name}/${to.kind}/main/${to.path}`}
      onNavigate={go}
    />
  )
}
```

A Markdown file renders as a read-only document. A relative link in it
resolves against the repository as GitHub resolves it and reaches `onNavigate`.

## Render a patch

`PierreDiffView` takes a unified patch string and renders it with per-token
syntax highlighting. `layout` chooses side by side (`"split"`, the default)
against a single unified column (`"inline"`), and `selectedPath` narrows a
multi-file patch to one file.

`patchToCodeViewItems` is the pure seam behind it, exported so you can ask
whether the patch parses before you commit to rendering it:

```tsx
import { patchToCodeViewItems, PierreDiffView } from "@smthrs/repo-view"

function readable(patch: string): boolean {
  const items = patchToCodeViewItems(patch)
  return items.length > 0 && items.every((item) => item.type === "diff" && item.fileDiff.hunks.length > 0)
}

export default function DiffSurface({ patch }: { readonly patch: string }) {
  return readable(patch)
    ? <PierreDiffView layout="inline" patch={patch} />
    : <pre>{patch}</pre>
}
```

A patch the renderer cannot read falls back to the verbatim text, which is the
honest outcome: nothing is drawn that the source did not contain. A patch
without a `diff --git` line has its `---` and `+++` labels read as a rename;
prepend `diff --git a/<old> b/<new>` built from the paths you already hold.

Theme and palette follow the document by default. Pass `mode` or `palette` only
when you are rendering into a surface that deliberately differs from the page.

## Render one file

`CodeFileView` highlights a whole file on the same engine. The grammar comes
from the file name's extension, and `languageForFile` tells you in advance when
no grammar claims it, so you can keep your own plain text instead:

```tsx
import { CodeFileView, languageForFile } from "@smthrs/repo-view"

export function FileSurface({ contents, line, name }: {
  readonly contents: string
  readonly line?: number
  readonly name: string
}) {
  return languageForFile(name) === null
    ? <pre>{contents}</pre>
    : <CodeFileView contents={contents} line={line} name={name} />
}
```

`line` is 1-based. Setting it marks that line and scrolls it into the middle of
the nearest scrolling ancestor; changing it moves the mark and scrolls again.
Until the highlighter has painted, the component renders a plain `<pre>`, so
there is no blank frame.

`CodeFileView` automatically starts the worker pool for its theme on first use. The
package supplies Bun and browser worker factories, with a 15-second
initialization deadline (`CODE_VIEW_POOL_DEADLINE_MS`). Highlighting falls back
to the main thread only when workers are unavailable or the pool fails: a
worker error or a missed initialization deadline.

For embedded page teardown, call `disposeCodeViewPool` after unmounting its
code views, while its DOM still exists. This releases the page's pools so the
next page can start fresh ones.

## Edit markdown

`MarkdownEditor` is the Milkdown Crepe WYSIWYG surface behind an injectable
`loadEditor` seam. `value` is the initial document, not a controlled value:
re-seeding on every keystroke would move the caret. Live edits arrive through
`onChange`.

Render `MarkdownEditorStyles` once to ship the Crepe theme:

```tsx
import { MarkdownEditor, MarkdownEditorStyles } from "@smthrs/repo-view"

export function NoteEditor({ initial, onChange }: {
  readonly initial: string
  readonly onChange: (markdown: string) => void
}) {
  return (
    <>
      <MarkdownEditorStyles />
      <MarkdownEditor
        onChange={onChange}
        onError={(error) => console.warn(error.code, error.cause)}
        value={initial}
      />
    </>
  )
}
```

The component decides between the rich editor and a controlled textarea with a
layout probe, exported as `supportsRichTextEditing()` for a host that wants to
branch on the same answer. Pass `fallback` to force one path. The rendered
`data-mode` attribute reports which path is live: `"wysiwyg"`, `"fallback"`, or
`"failed"`.

A failed load is not a lost document. The component reports `editor-load-failed`
or `editor-create-failed` through `onError` and renders a seeded textarea with
`data-mode="failed"`, so editing continues in plain text. See
[Failure codes](../reference/contracts.md) for both codes.

## Confirm what landed in your bundle

A view belongs to whichever chunk imports it, so the check is your bundler's
production output. Build for production and find the chunk that holds
`@pierre/diffs`. It should be a lazily loaded chunk. If it is the entry chunk,
a module on your initial route imports a view eagerly: follow the import back
and move it behind the lazy boundary. Shiki's grammars and Milkdown stay in
their own chunks either way.

## Related

- [API reference](../api.md): every export.
- `@smthrs/ui`'s guide "Use a heavy renderer": the terminal, chart and graph
  adapters that stay in that package.
