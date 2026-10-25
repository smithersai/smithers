# Code intelligence

A TypeScript or JavaScript file in the repository view has a language server, as GitHub's code view and github.dev do: a hover card with the symbol's signature and documentation, go to definition in the same file or another, every reference in the Symbols pane, the file's outline, and its problems in the gutter. Everything works from the keyboard. TypeScript's language service runs in a worker in the tab, over the files of the commit the view shows, so it needs no machine, costs nothing per reader and keeps working offline for files the browser has cached. Design: [design/code-intelligence/DESIGN.md](../design/code-intelligence/DESIGN.md), with its [mock](../design/code-intelligence/mock.html).

## How it works

```
RepoPage ── RepoView (code, aside) ── CodeFileView: marks, hover card, cursor ── SymbolsPane
   │ pointer rest, click, ⌘-click, keys
   ▼
CodeIntel actions ── LanguageServers.open ── @smthrs/std LanguageServer (LSP answers)
   │                   BrowserLanguageServer.make ── postMessage ──▶ language.worker.ts: serve(typescript, lib.*.d.ts)
   │                     reads ◀── RepoClient.blob ◀── GET /api/repos/<o>/<n>/blob/<sha>/<path> (immutable)
   ▼
lsp.ts decodes ── the code-intel row (local TanStack DB) ── view.ts ── the components
```

- **It follows the view.** `CodeIntel.layer` watches the repository view's routed file. When the view shows a `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` or `.cjs` file at a commit whose file list is loaded, the file opens in that commit's server, which starts once per repository and commit (`LanguageServers.layerBrowser`, `ScopedRef`), and its problems and outline load. Another file of the commit reuses the server; another commit replaces it; any other file clears the row.
- **The worker reads through the tab.** The worker asks for files by path; the tab reads them through `RepoClient` at the commit, so the immutable caches the view fills serve them, and keeps their text for the Symbols pane's lines. TypeScript and its lib files load in the worker's own chunk only when the first such file shows.
- **Answers are LSP.** `src/features/code-intel/lsp.ts` decodes `Hover`, `Location[]` and `LocationLink[]`, `DocumentSymbol[]` and a full diagnostic report with Effect Schema. Places outside the repository, such as TypeScript's own lib files, are left out.
- **Packages.** A commit holds no `node_modules`, so a package's types are unknown and problems that only say a package is missing are left out ([`@smthrs/platform-browser`'s language server](../../../../packages/smithers/flows/platform-browser/docs/api.md#the-language-server)).
- **A plugin, before the plugin host.** Code intelligence is the first-party `code-intel` plugin of decision [0017](../decisions/0017-everything-is-a-plugin.md); until the plugin host exists it is the one folder `src/features/code-intel/`, with one line in `boot.ts`, `main.tsx`, `RepoPage.tsx` and `telemetry.ts` each.
- **Libraries** (`docs/libraries.md`): `@smthrs/platform-browser`'s `BrowserLanguageServer` binding `@smthrs/std`'s `LanguageServer`; `@smthrs/repo-view`'s `CodeFileView` (`marks`, `hover`, `cursor`, `onCursorMove`, `onTokenSelect`), `RepoView`'s `code` and `SymbolsPane`; `@smthrs/effect-tanstack-db` for the row; the repository feature's `RepoClient` and `app/navigate`.

## What a person does

| Gesture | Key | What happens |
|---|---|---|
| Rest the pointer on a token | | The hover card: the signature as code, the documentation, problems under the token |
| | `Tab` | The code takes focus; the cursor lands on the first symbol at the anchored line |
| | `←` `→` `↑` `↓` | The cursor moves between symbols, and the card follows it |
| Click a token | `r`, `Shift+F12` | The Symbols pane: its definition, and every reference grouped by file; its occurrences in the file are highlighted |
| ⌘-click or Ctrl-click | `Enter`, `F12` | Go to the definition: the line in this file, or the defining file at the same revision through `app/navigate`, with the cursor on it |
| The toolbar's problem count | `F8`, `Shift+F8` | The next or previous problem, around the file, with its card |
| Symbols | `o` | Shows or hides the Symbols pane; with no symbol selected it is the file's outline, with a filter |
| | `Esc` | Closes the card, then the pane |
| A row in the pane | `↑` `↓` `Enter` | Opens that line |

A definition's or reference's row is a link to `/<owner>/<name>/blob/<revision>/<path>?L=<line>`, so it opens in a new tab and Back returns.

## The browser

`src/features/code-intel/`:

| File | Holds |
|---|---|
| `contract.ts` | the files served, the toolbar's words, the outline's kind labels, `CODE_INTEL_TELEMETRY` |
| `session.ts` | `LanguageServers`: `layerBrowser(worker)` in production, `layerNone` for a host with no worker |
| `rows.ts`, `store.ts` | the one local row, the running server, the shown file, the latest hover asked for, the cursor's landing |
| `actions.ts` | opening the routed file, hover, select, definition, problems, the pane and the keys |
| `lsp.ts`, `view.ts` | decoding answers; what the view draws from the row |
| `codeIntel.ts` | `CodeIntel`: the live query and plain actions frontends use |
| `language.worker.ts` | the worker entry, a program boundary like `main.tsx` |
| `components/` | the provider, and the code's props, the pane and the toolbar's buttons for `RepoPage` |

An answer to an older hover, or for a file or symbol the view has left, is dropped. A parent render preserves a pending pointer rest; leaving the token, replacing the file or unmounting the code view cancels it.

## Observability

Content-free: acts, methods, outcomes and counts, never a path, a symbol or text. See [observability.md](../observability.md#code-intelligence).

## Tests

- `src/features/code-intel/code-intel.test.ts`: a real clone on RepoApi over the compose Postgres and Electric, and the real language server in the process (`src/test/languageServer.ts`): problems and the outline, hover and a dropped older answer, selecting a symbol, definitions in another file and the same one, every key, problems in order around the file, a server that answers nothing (`LanguageServers.layerNone`), and the decoders.
- `packages/smithers/flows/platform-browser/test/BrowserLanguageServer.test.ts` and `packages/smithers/ui/repo-view/test/code-intelligence.test.tsx`: the SDK halves.
- `e2e/code-intel.spec.ts`: `vercel/ms` at a fixed commit: hover `format`, Enter to its definition in `src/index.ts`, its references in the Symbols pane, and a reference's line.

## Next

The design's slices: the agent's `code/*` flows on the same server, package types, the branch box's servers for other languages, search-based navigation, and blame.

## Response ordering and keyboard safety

Definition navigation is discarded after another request or routed target replaces it. Escape invalidates a pending hover as well as dismissing a visible card. Keyboard selection tolerates text still loading and resolves its name after the server reads the file. Ref and default-branch changes refresh link metadata even at the same commit and path. Ctrl, Meta and Alt shortcuts stay with the browser. Malformed location URI escapes fail as `Unreadable`, through the existing failed-request metrics, span and warning.

Regression evidence: `src/features/code-intel/code-intel.test.ts`, using delayed real TypeScript requests through `LanguageServers`.
