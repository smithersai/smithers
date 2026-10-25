---
title: "API reference"
description: "Every export of @smthrs/repo-view: RepoView, CodeFileView and its worker pool, PierreDiffView and its helpers, MarkdownEditor, the live editors CodeEditor and LiveMarkdownEditor, and the package's style sheet."
sidebar:
  order: 1
---

Everything below is exported from the package root, `@smthrs/repo-view`. The
package has no other entry point.

Component props types follow the shape `ComponentProps<"element"> & { ... }`
where a view renders one element, so a view also accepts that element's host
attributes and handlers.

## Styles

```ts
const repoViewCss: string
const REPO_VIEW_STYLE_ATTR: "data-smithers-repo-view"
function RepoViewStyles(): JSX.Element
```

`repoViewCss` is the sheet for `RepoView`, `CodeFileView` and
`PierreDiffView`. It reads `@smthrs/ui`'s theme tokens, so the views follow
light and dark, and every class is `sui-` namespaced. In a browser each view
appends it to `<head>` once, under `REPO_VIEW_STYLE_ATTR`. Render
`<RepoViewStyles />` once near the root where effects never run, such as a
server render; a view then finds the marked sheet and adds nothing.

## Repo view

```ts
type RepoViewLocation = { kind: "tree" | "blob"; path: string; line?: number; lineEnd?: number }
type RepoViewTree =
  | { state: "loading" }
  | { state: "ready"; paths: ReadonlyArray<string>; truncated?: boolean }
  | { state: "failed"; message: ReactNode }
type RepoViewFile =
  | { state: "loading" }
  | { state: "text"; contents: string; size: number }
  | { state: "binary"; size: number }
  | { state: "too-large"; size: number }
  | { state: "failed"; message: ReactNode }
type RepoViewSize = "inline" | "full"
type RepoViewMarkdownMode = "preview" | "source"
type RepoViewHtmlMode = "code" | "preview" | "split"

function HtmlPreview(props: HtmlPreviewProps): JSX.Element
function previewDocument(html: string): string
const HTML_PREVIEW_CSP: string
const HTML_PREVIEW_SANDBOX: "allow-scripts"
```

`RepoView` (`RepoViewProps`) is a repository browser. It shows the file tree
beside a directory's listing and its README, or a file as code or as a
Markdown document.

- **It fetches nothing.**
  - `tree` is every file's path at the revision. A ready tree's `directories`
    names folders known without their files, such as a repository's top level
    as GitHub lists it before a clone: they list and open as folders.
  - `file` is the file at a `blob` location.
  - `readme` (`{ path, file }`) is a directory's README, which the host
    chooses.
- **The host owns the location.** `location` says where the view is, `href`
  builds every link, and `onNavigate` takes a plain click on any of them,
  including a relative link in a Markdown document, which resolves against the
  repository as GitHub resolves it. One view therefore serves a routed page
  and a conversation.
- **`size`:** `full` (the default) puts the tree beside the content. `inline`
  drops the tree and bounds the content's height. Below 720 px of its own
  width, a `full` view drops the tree too: the view measures its container,
  not the window.
- **The tree's open directories:** `expanded` and `onToggle`. Uncontrolled,
  the view opens the location's directories as it navigates; a host that
  controls `expanded` does the same.
- **Markdown:** a file renders as a read-only WYSIWYG document by default.
  Preview and Code switch it to its source and back, through `markdownMode`
  and `onMarkdownModeChange`, controlled or not.
- **HTML:** a file opens as code; Preview shows the page live and Split shows
  the source beside it, as CodePen does, through `htmlMode` and
  `onHtmlModeChange`, controlled or not. The page is `HtmlPreview`: a frame
  sandboxed to `allow-scripts` alone, so it is an opaque origin that can't
  reach the app, its storage or its cookies, and opens no popup, form,
  download or top-level navigation. Its document (`previewDocument`) starts
  with `HTML_PREVIEW_CSP`: inline script and style only, images and fonts only
  from `data:` and `blob:`, and no network. A page that navigates itself anyway
  is put back on the file: the frame's second load remounts it.
- **The repository page:** `aside` draws a column on the right of a `full`
  view, such as an about panel, and moves under the content below 1,024 px of
  the view's width. `fileTree={false}` drops the tree on the left, as GitHub's
  repository page has none.
- **The host's slots:** `revision` leads the header, `actions` trails it,
  `summary` sits between the header and the content, `fileBadges` follows a
  file's stats and `fileActions` trails its toolbar.
- **Other props:** `codeMode` sets the code theme. `code` (`RepoViewCode`)
  passes a language server's help to the shown file's `CodeFileView`: its
  `marks`, `cursor`, `hover`, `annotations` and gestures. `markdownEditor`
  passes the editor's `fallback` and `loadEditor` seams.
- **States:**
  - A tree or file still `loading` shows skeleton lines in its place, named
    `Loading files` or `Loading <path>`, after `@smthrs/ui`'s `LOADING_DELAY_MS`.
  - A `failed` one shows its message as an alert.
  - A location that isn't in the tree shows "Not found".
  - A binary or too-large file shows its size.

## Code view

```ts
function CodeFileView(props: CodeFileViewProps): JSX.Element
function languageForFile(name: string): string | null

const CODE_VIEW_REST_MS: 300
const CODE_VIEW_POOL_DEADLINE_MS: 15000
const currentCodeViewPool: () => CodeViewPool
const subscribeCodeViewPool: (listener: () => void) => () => void
const disposeCodeViewPool: () => void

type CodeViewMode = "light" | "dark"
type CodeViewPoolState = "off" | "starting" | "ready" | "failed"
interface CodeViewPool { readonly state: CodeViewPoolState; readonly manager: WorkerPoolManager | undefined }
```

`CodeFileView` (`CodeFileViewProps`) renders one file: `name` supplies the
grammar, `contents` the text, `line` a 1-based anchor that is marked and
scrolled into view, `lineEnd` widens the mark to the range from `line` to it,
and `mode` and `palette` override the document's theme.
`annotations` (`CodeLineAnnotation`) render under their lines, and the consumer
must memoize the array because a new one redraws the rows. `onTokenRest` fires
once per token after the pointer rests for `CODE_VIEW_REST_MS`, including across parent renders, reporting a
`CodeTokenPosition`; `onTokenActivate` fires on ⌘-click or Ctrl-click.

A language server's answers draw through the rest, with no state of their own:

| Prop | What it draws |
|---|---|
| `marks` (`CodeMark`) | `symbol` highlights the token starting at a 1-based `line` and `column`; `error`, `warning` and `info` underline the tokens starting from `column` up to `end` (exclusive, at most 200 columns) and mark the line in the gutter. They become one sheet in pierre's shadow root (`codeMarksCss`). |
| `cursor` | Outlines the token at the keyboard cursor and scrolls it into view once per move. |
| `hover` (`CodeHover`) | A card under its token: `signature` as code, `body`, then `problems` (`CodeProblem`) by severity. The code names it with `aria-describedby`. |
| `onTokenSelect` | A plain click on a token that ended no text selection. |
| `onCursorMove`, `onKeyDown` | Either one makes the code focusable. The arrow keys move the cursor through the symbols pierre drew (`moveCursor`: identifiers that aren't reserved words, `isSymbolText`); focus from the keyboard without a cursor lands it on the first symbol at or after `line`. Every other key, and an arrow with a modifier, goes to `onKeyDown`. |

`languageForFile` answers `null` when no grammar claims the name, which is the
signal to keep your own plain text. Until the highlighter paints, the component
renders a plain `<pre>`.

The views share one worker pool per page. `currentCodeViewPool` and
`subscribeCodeViewPool` read its state; `disposeCodeViewPool` releases it after
a page unmounts its code views.

## Symbols pane

```ts
function SymbolsPane(props: SymbolsPaneProps): JSX.Element

interface SymbolsPaneLocation { path: string; line: number; text: string }
interface SymbolsPaneOutlineItem { name: string; kind: string; line: number; depth: number }
interface SymbolsPaneSymbol {
  name: string
  definitions: ReadonlyArray<SymbolsPaneLocation> | undefined
  references: ReadonlyArray<SymbolsPaneLocation> | undefined
}
```

`SymbolsPane` is the pane GitHub's code view keeps on the right, for
`RepoView`'s `aside`. With a `symbol`, it lists its definitions and its
references, grouped by file with a count, each row a line number and that
line's text; a list that is `undefined` is still loading and shows no rows.
Without one, it shows `outline` with a filter, each entry indented by `depth`.
Every row is a link built by `href`; a plain click or Enter calls `onOpen`.
↑ and ↓ move between rows, and Escape or Close calls `onClose`.

## Pierre diff view

```ts
function PierreDiffView(props: PierreDiffViewProps): JSX.Element
function patchToCodeViewItems(patch: string, selectedPath?: string | null): CodeViewItem[]
function diffsThemeForMode(mode: PierreDiffMode, palette?: ResolvedPalette): DiffsThemeNames
function diffStyleForLayout(layout: PierreDiffLayout): "split" | "unified"
function normalizeDiffPath(path: string | undefined): string

type PierreDiffMode = "light" | "dark"
type PierreDiffLayout = "split" | "inline"
```

`PierreDiffView` (`PierreDiffViewProps`) renders a unified patch: `layout`
chooses side by side against unified, `selectedPath` narrows a multi-file patch
to one file, and `emptyLabel` covers an empty or unparseable patch.
`unsafeCSS` takes trusted, static host CSS for pierre's shadow surface; never
pass it repository content.

`normalizeDiffPath` decodes git's quoted, octal-escaped path form and strips a
leading `a/` or `b/`, which is why `selectedPath` compares equal across all four
spellings of a name.

Syntax token colors follow the resolved `mode` and `palette`, which default to
the document's theme and palette. `diffsThemeForMode` selects
`themeRegistry[palette].syntax.shikiLight` or `shikiDark` for light or dark mode.
Calling the helper without a palette uses `"paper"`, the registered Paper
palette. Set it explicitly on the component:

```tsx
<PierreDiffView patch={patch} palette="paper" />
```

Registered palettes select bundled Shiki themes. The view exposes no
registration prop for custom unregistered themes; those require a separate
highlighter and worker registration path.

## Markdown editor

```ts
function supportsRichTextEditing(): boolean

const markdownEditorCss: string
const MARKDOWN_EDITOR_STYLE_ATTR: string

type MarkdownEditorErrorCode = "editor-load-failed" | "editor-create-failed"
```

`MarkdownEditor` (`MarkdownEditorProps`) takes `value` as the initial document,
not a controlled value, and reports edits through `onChange`. `resetKey` forces
a re-seed when the host switches documents. `loadEditor`
(`MarkdownEditorModule`) is the injectable module loader, which is how a test or
a host with its own build drives the rich path. `escapeTabOrder` defaults to
true so Tab moves focus out rather than trapping a keyboard user. `fallback`
forces the textarea or the rich editor, overriding the
`supportsRichTextEditing` probe. `onLinkClick` receives a clicked link's
`href` as written in the markdown; returning true stops the browser from
following it, which is how a host opens a document's relative links itself.
`readOnly` shows the document without editing, and an HTML node in it shows as
its text. `MarkdownEditorHandle` exposes `getMarkdown` and the imperative seams.
Images stay inline Markdown images, so their alt text and title round-trip
unchanged. Crepe's image block is off because it saves its display ratio as
the alt text.

`MarkdownEditorStyles` ships the Crepe theme in a `<style>` element; every
editor also injects it in the browser. `MarkdownEditorError` carries a `code`
and the original `cause`; both codes are described in
[Failure codes](./reference/contracts.md).

## Live editors

```ts
function CodeEditor(props: CodeEditorProps): JSX.Element
function LiveMarkdownEditor(props: LiveMarkdownEditorProps): JSX.Element
```

Both edit a text several people change at once, such as `@smthrs/sync`'s
`SharedText`. Each is controlled: `value` is the text as everyone wrote it,
and each of the person's own edits comes out through `onChange` with `base`,
the text the edit was made on, so the host can merge it past edits that
arrived meanwhile (`SharedText.replace(value, { base, caret })`). A `value`
that changes from outside goes in without coming back out as an edit.

- `CodeEditor` is CodeMirror. An outside `value` goes in as one change that
  CodeMirror maps the person's selection through. `onChange` also carries the
  selection after the edit, and `onSelectionChange` the selection when only it
  moves. `collaborators` (`@smthrs/ui`'s `Collaborator`) draws everyone else's
  carets and selections in their colors, flagged with their names, with
  `@smthrs/ui`'s styles on the page. `readOnly` shows the text without editing.
- `LiveMarkdownEditor` is `MarkdownEditor` over a shared document: an outside
  `value` goes in through `setMarkdown`, which keeps the caret. It takes every
  other `MarkdownEditor` prop. It draws no carets: the editor shows rendered
  Markdown, not its source positions.
