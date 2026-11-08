# Wiki in the app (brick 1e; VL-17, VL-23)

The project wiki lives in the chat as a maximizable pane (VL-17). Open `index.html` and use the top bar to switch
screens; every screen renders at 1280px and 390px with no horizontal scroll (shots in `shots/`).

## Screens and states

| Screen | What it shows |
| --- | --- |
| `splash` | Entry point: the top nav gains **Wiki** between Mock and Docs. |
| `chat` | The wiki pane open in the conversation on Home, above the transcript. Main screen. |
| `rulings` | A content page: breadcrumb `Wiki / Rulings`, quoted rulings. |
| `decision` | Decision 0014: status badge **Accepted**, date, cited rulings as chips (VL-28, VL-13, VL-16, VL-17). |
| `maximized` | The pane maximized over the chat (fixed, under the top bar), Roadmap page; minimize returns it. |
| `search-empty` | Empty state: "Find a page" with no matches — "No pages match "zebra"". |
| `loading` | Skeletons in the page list and content; the maximize toggle is disabled. |
| `error` | "The wiki didn't load" with **Retry** (the chat's `vl-link` pattern, like Reconnect). |
| `edit-maintainer` | Maintainer editing Roadmap: code textarea, **Cancel** / **Save**. |
| `propose-contributor` | Contributor editing: same editor, save button reads **Propose**. |
| `agent` | The agent opens a page from the chat: a person asks, the pane opens on decision 0013 between the post and the answer, and the answer names what it opened. |

## Interactions and keyboard paths

- **Open the wiki.** Click **Wiki** in the top nav (Tab to it, Enter). The pane opens in the conversation as a
  `PaneOpened` event, exactly like the tour's docs pane (0014), so every client and the agent see the same thing.
- **Move between pages.** The left page list (Find a page filter, Home/Rulings/Roadmap, then numbered decisions,
  newest first). Tab moves through the filter and each page link; Enter opens. On screens ≤720px the list becomes a
  horizontal tab row above the content.
- **Breadcrumb.** `Wiki / Decisions / 0014`; each parent is a button that walks up.
- **Maximize / minimize.** The pane-bar toggle (Lucide maximize-2/minimize-2, same paths as the docs pane). With the
  pane focused or maximized, **Esc** minimizes it back into the chat. The maximized pane keeps the page list.
- **Ruling chips.** On a decision page, each cited ruling (VL-28…) is a chip-button that opens Rulings scrolled to
  that ruling's anchor. Status is a `sui-badge-success` "Accepted" (a superseded decision would read "Replaced").
- **Edit by role.** The pane bar shows **Edit** only for contributor and maintainer (a view you aren't authorized
  for never appears). Edit swaps the body for a `sui-textarea[data-code]` of the page's Markdown. Maintainer's save
  button: **Save** (applies directly). Contributor's: **Propose** (sends the edit for maintainer review). Cancel or
  Esc leaves without saving. Viewer, new and community never see Edit.
- **The agent opens a page.** The agent's reply flow emits the same `OpenPane` intent the tour uses, with a wiki
  page id instead of a docs URL; the person can then drive the pane themselves. The agent acts, it does not give
  instructions.
- **Error/loading.** Pane-scoped, not page-scoped: a failed wiki never breaks the chat under it.

## Components

Reused from the live app, unmodified: `vl-top`/`vl-nav`/`vl-nav-link`/`vl-pill`/`vl-logo`, `vl-pane` (the collapsed
splash), `sui-chat-*` (messages, bubbles, labels, docked composer), `sui-badge` (+`-success`, `-outline`),
`sui-input`, `sui-textarea[data-code]`, `sui-skeleton`, `sui-empty`, `sui-md-*` for rendered Markdown,
`vl-docs`-pattern pane chrome (bar + toggle), Lucide maximize/minimize paths.

New (`vl-wiki-*`, in `src/web/styles.css` beside the docs pane styles):
`.vl-wiki` (pane shell), `.vl-wiki-bar` + `.vl-wiki-crumb` (breadcrumb), `.vl-wiki-toggle`, `.vl-wiki-body`
(188px page list + content grid), `.vl-wiki-pages` + `.vl-wiki-page-link` (+`data-kind="decision"` mono),
`.vl-wiki-find`, `.vl-wiki-pages-head`, `.vl-wiki-content`, `.vl-wiki-meta` (status/date/ruling chips),
`.vl-wiki-edit-body` + `.vl-wiki-edit-footer`. `data-maximized="true"` pins it like the docs pane.

## Copy (every visible string)

Nav: "Wiki". Pane bar: "Wiki", "Wiki / Rulings", "Wiki / Decisions / 0014", "· editing". Page list:
"Find a page", "Home", "Rulings", "Roadmap", "Decisions", "0014 agent-tour"… Decision meta: "Accepted",
"2026-11-07", "VL-28"… Editor: "Cancel", "Save" (maintainer), "Propose" (contributor). Empty: `No pages match
"<query>"`. Error: "The wiki didn't load", "Retry". Toggle aria-labels: "Maximize the wiki" / "Minimize the wiki".
Page bodies are the real Markdown from `app-src/wiki/`.

## Choices

- **Pane, not a route.** VL-17: HTML lives in chat panes; the nav link opens the pane instead of leaving the chat.
- **Page list inside the pane, GitHub-wiki style.** GitHub wikis put Pages in a sidebar; on phone it collapses to a
  scrolling row rather than a hamburger — one pattern, no new chrome.
- **Decisions are first-class pages** in the same list (mono, numbered, newest first) because the wiki's job is
  recording decisions (VL-23).
- **Status + cited rulings on the decision page itself**, not only in Markdown text: status is the question everyone
  asks of a decision, and the chips make rulings one tap away.
- **Edit reuses the pane** rather than a separate editor page: GitHub's wiki editor is a page, but our page is the
  pane; a Markdown textarea + Save is the smallest honest editor (VL-5, minimalism).
- **Contributor saves read "Propose"** so the button says what will happen; review lands with brick 3's
  contribution flow, the proposal is its input.
- **The mock ships the real pages** from `app-src/wiki/` as static data (VL-13); mock search filters them locally.
