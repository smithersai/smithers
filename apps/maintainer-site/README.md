# Maintainer site

A local site for maintainers: Will's decision queue, a Work board of every workstream, a gallery of every end-to-end flow GIF, and an Obsidian-like knowledge base of the repository's docs with backlinks, a graph, an outline per note and full-text search.

It is the tool we dogfood, not the product. Its review queue is becoming a product feature, a plugin in `apps/mvp`, and gets evaluated heavily ([rulings](../mvp/docs/rulings.md) PLUGIN-4, PLUGIN-6). The Work board and knowledge base stay here for now; they will most likely become the app's wiki feature later (PLUGIN-5).

## Decision queue

```sh
node apps/maintainer-site/serve.mjs   # http://localhost:4747/queue
```

One item fills the screen, highest priority first: a decision, a question, a code slice, a design, a flow GIF, or a fix to verify. Every action has a key; `?` lists them. With an empty box an action key sends at once; with text in the box it picks, and `⌘Enter` sends. Click a line number to start a note about that line (`L42: `). Drafts stay in the browser until they are sent.

A recording (`{ "type": "video", "path": "….mp4", "chapters": "….chapters.json" }`; the file is `apps/mvp`'s `{ title, feature, name, line, status, theme, chapters }`, with `chapters` `[{ "t": seconds, "label": "step" }]`, or that bare list) plays in the review player: a timeline with a tick and a label per chapter, the current one lit; click one to seek. `space` plays or pauses, `←` `→` skip 2 s, `,` `.` step a frame, `[` `]` jump between chapters, `<` `>` set the speed from 0.5× to 2×, `0` goes back to the start. Typing a note pauses the recording and starts the note with its moment, such as `[02:14 Save] `. GIFs play as before.

A Markdown file in `media` (`.md`, or `"type": "md"`) reads like a README on GitHub: `markdown.mjs` renders it on the server, with links and images resolved beside the file through the file endpoint, and the page colours its code blocks. Links open in a new tab, `#anchors` scroll the page, `j` `k` scroll, and `o` shows the raw source. Attachment buttons open the selected file; `o` continues cycling through the source and attachments.

A TypeScript or JavaScript slice has three reading tools, each a key and a button. `c` hides comments, whole lines and blocks, and comments beside code; the code closes up, every line keeps its file number, and the choice stays in the browser. `z` folds every function, method, class and object body and every statement block of six lines or more, and `Z` unfolds them all. A chevron in the gutter folds one body, and a folded body reads as its first line, `{ … }`, and its line count; click the dots to open it. `O` opens the outline: the slice's declarations, members and Effect.gen's named steps (`const user = yield* …`) in file order, nested. Type to filter, `↑` `↓` to pick, and `Enter` or a click to jump; the line opens out of any fold and is marked. A `path:42` reference in the guide links to its line the same way, past hidden comments and folds. The ranges come from TypeScript's own parser on the server (`outline.mjs`), never regular expressions, so `//` in a string or a regular expression stays code.

`g` marks a note as applying to every item of the item's kind (zoom, a missing timeline): a badge shows while composing, the answer records `"scope": "all"` and the kind, and a toast confirms it. Undo restores the note and its scope.

A verify item with `before: { media, note, stamp }` and `after: { media }` shows before and after: two recordings side by side on one timeline (the old one follows to the same chapter and offset, and opens on Will's first stamped note, pinned where he made it), two designs or images side by side, or a diff for code with his `L42:` notes on the old lines. Annotated lines and three lines of context stay visible even in unchanged parts of the file. `b` cycles both, before and after. Without `before.media`, the after recording plays alone with the note pinned at its stamp. The curator keeps old media in `queue/before/<id>/`.

| File | Owner | Role |
| --- | --- | --- |
| `queue/queue.json` | the curator | `{ version, generatedAt, items }`, rewritten whole by an atomic rename |
| `queue/coverage.json` | the curator | The code slices and whether Will has reviewed them; the header shows the share of lines reviewed |
| `queue/answers.jsonl` | `serve.mjs` | Will's answers, one fsynced line each, append-only; `undo` is an appended record |

The server runs on macOS or Linux (with procfs available); file reads fail closed on other hosts. It has no dependencies and binds to 127.0.0.1. It refuses another host name and another site's `Origin`.

| Endpoint | Returns |
| --- | --- |
| `GET /api/queue` | The items, minus those answered (until the curator re-adds them with a newer `addedAt`) or snoozed with `later` in the last 24 hours |
| `GET /api/events` | A server-sent `queue` event when `queue.json`, `coverage.json` or `answers.jsonl` changes, or a snooze ends |
| `POST /api/answer` | Appends an answer: `{ itemId, action, option?, scope?, text, revision, commit, addedAt }`, the last three naming the version Will opened; the server stamps `at`, `revision`, `title`, and with `scope: "all"` the item's `kind`. If the curator replaced the item since, it refuses with 409 and the queued version, and the page shows that version |
| `GET /api/file?path=…` | A file under the repository, `~/Desktop/smithers-mvp/gifs`, `~/Desktop/smithers-mvp/videos` or `queue/before`, read-only, with byte ranges so a video can seek. Refuses paths and symlinks that leave those roots, `.git`, `.jj`, `node_modules`, `.env*` and secret names. Reads, byte ranges, Markdown and outlines use the checked file descriptor, so replacing the file path cannot redirect a response. `/api/file/<path>` serves the same file so a design's relative styles load |
| `GET /api/outline?path=…` | A TypeScript or JavaScript file's `{ supported, comments: { lines, inline }, folds, symbols }`, with the file endpoint's roots and refusals; lines 1-based, columns 0-based; `{ supported: false }` for other files. TypeScript loads from the workspace on the first request, and each outline is cached until the file changes |
| `GET /api/markdown?path=…` | A Markdown file rendered to HTML, `{ html, title }`, with the file endpoint's roots and refusals |
| `GET /api/stats` | Answers today, remaining by kind, and coverage |

Code slices send `slice=<id>` to the file and outline endpoints. A slice’s `commit` pins both to jj history (with a 32-entry cache by commit and path); `revision` is only its text hash. Older slices without `commit` read the working copy. An unavailable commit returns 404.

The server also serves the built site at `/`. Set `PORT`, `QUEUE_DIR`, `MAINTAINER_SITE_REPO`, `MAINTAINER_SITE_GIFS`, `MAINTAINER_SITE_VIDEOS` or `MAINTAINER_SITE_OUT` to change where it listens and reads.

```sh
pnpm --filter @smthrs/maintainer-site test         # renderer, server and outline tests
pnpm --filter @smthrs/maintainer-site test:queue   # checks attachment selection and review-note context, then drives the queue by keyboard in Chromium; writes screenshots/queue-*.png
pnpm --filter @smthrs/maintainer-site test:code    # the code tools (comments, folds, outline) by key and click in Chromium
```

```sh
pnpm --filter @smthrs/maintainer-site build   # or: node apps/maintainer-site/build.mjs
open ~/Desktop/smithers-maintainer/index.html
```

The build has no dependencies and takes well under a second. It prints the path to `index.html`, and warns about broken links, flows without a GIF, and GIFs without a test.

## What it reads

| Content | Source |
| --- | --- |
| Flows | `~/Desktop/smithers-mvp/gifs/<spec>-<test>.gif`, from `pnpm --filter @smthrs/mvp e2e:gifs`, matched to `test("…")` in `apps/mvp/e2e/<spec>.spec.ts` |
| Notes | every Markdown file under `apps/mvp/docs/`, `apps/mvp/AGENTS.md`, `AGENTS.md`, `docs/libraries.md`, `README.md` |
| Decisions on the home page | `apps/mvp/docs/decisions/*.md` and their `Status:` line |
| Work board (`#/work`) | `apps/mvp/docs/work/*.md`, one per workstream. Front matter sets `title`, `status` (idea, todo, designing, in-progress, blocked, done), `area` (app, sdk, infra, design, process), `owner`, `updated` and `links`. The board has a column per status and filters by area; the nav counts items not done. |

Set `MAINTAINER_SITE_GIFS` or `MAINTAINER_SITE_OUT` to read GIFs from or write the site to another folder.

## What it writes

`~/Desktop/smithers-maintainer/`: `index.html`, `assets/` (the client, its styles, and `data.js` with every note rendered), and `gifs/`. A rebuild replaces those and keeps `screenshots/`.

- Relative links between notes open in the site; links to other repository files open the local file; a link to a missing file is red.
- `[[name]]` links a note by path, title or file name.
- A note's front matter (`---` `key: value` lines) shows as a properties table under its title; a `links` list counts toward backlinks and the graph. The build rejects unsupported work-note status values before replacing the site. Finished work uses `done`; `complete` and `completed` are invalid. An empty status is invalid too. Unparsable lines, absent status fields and unknown areas remain warnings.
- `/` focuses search. In search, ↑ and ↓ pick a result and Enter opens it. In the large GIF view, ← and → step through flows.

## Files

| File | Role |
| --- | --- |
| `build.mjs` | Reads the sources, resolves links and backlinks, writes the site |
| `markdown.mjs` | The Markdown renderer: CommonMark blocks and inlines, GFM tables, task items, strikethrough, autolinks and alerts, wikilinks, front matter; raw HTML sanitized to an allowlist |
| `client/site.js`, `client/site.css` | The page: hash routes for home, work, flows, graph, search and notes |
| `markdown.test.mjs` | Renderer tests: `pnpm --filter @smthrs/maintainer-site test` |
| `screenshots.mjs` | Opens the built site in Chromium (apps/mvp's Playwright), checks every view and fails on a console error; saves screenshots to `screenshots/` |
| `serve.mjs` | The local server: the queue API, live events, the read-only file endpoint, outlines, and the built site |
| `outline.mjs` | A code file's comment ranges, folds and symbols from TypeScript's parser, for the queue's code tools |
| `client/queue.html`, `client/queue.js`, `client/queue.css` | The queue page: keys, the code view with hand-written syntax colour and its tools (comments, folds, outline), the review player for recordings, media and designs in a sandboxed frame |
| `test/serve.test.mjs` | Server tests: the API, append and undo, snoozes, events, byte ranges, and every file refusal |
| `test/queue.e2e.mjs`, `test/fixtures/` | The keyboard-only check over one item of each kind; writes `screenshots/queue-<kind>-<theme>.png` |
| `test/outline.test.mjs` | Outline tests on real repository files: comment ranges (not `//` in strings or regular expressions), folds and symbols |
| `test/code-tools.e2e.mjs` | The code tools in Chromium, by key and click: hide comments, fold and unfold, the outline, guide line references |
