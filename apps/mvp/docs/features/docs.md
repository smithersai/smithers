# A repository's docs

A repository's docs open in the app: in its **Docs** tab, which anyone can read, signed out included, and in the conversation, where `app/docs/search` finds pages and shows one to three of them. VibeLang's factory is the first use, with vibelang.sh as its docs. Nothing here is VibeLang's: any repository whose home names an `llms.txt` index gets the same. Will, 2026-10-21 (AGENT-6): "We want to be able to view these vibelang docs in the smithers app panes there should be an agent based tool call for searching docs that can render 1 or more docs pages from vibelang in the vibelang smithers factory". The library is `@smthrs/views`' `Docs` ([read a docs index](../../../../packages/smithers/ui/views/docs/read-a-docs-index.md)); a page renders with `@smthrs/ui`'s `DocsPageView` ([show a docs page](../../../../packages/smithers/ui/docs/guides/show-a-docs-page.md)).

```
.smithers/home.json { "docs": "https://vibelang.sh/llms.txt", … }   (else Smithers' curated home's "docs")
        │ GitHub, through the about read RepoApi keeps (worker/RepoAbout.ts `cached`)
        ▼
ChatApi  worker/docs/Source.ts ─ Docs.fetchText(index) ─ Docs.parse ─ Docs.search / Docs.find ─ Docs.fetchText(page)
        │  kept 5 minutes in the repo EdgeCache, by URL
        ├─ GET /api/repos/<o>/<n>/docs[?q=]         ─▶ the Docs tab's index and search
        ├─ GET /api/repos/<o>/<n>/docs/page?path=   ─▶ the Docs tab's page; app/docs/search's text
        └─ POST /api/views { template: "docs", props: { url, title, repository, path } }
              ChatApi reads the page itself and keeps its Markdown (64 KiB) ─▶ Postgres views ─▶ Electric ─▶ every device
app/docs/search { repository, query, pages?, conversationId? }  (the agent's ctx.call, or /docs <owner/name> <query>)
   app/docs/plan (sealed: the views' ids) ─ app/docs/find (search) ─ app/docs/show (page + view, for each)
```

## Where docs come from

A repository names its docs index in `.smithers/home.json` (`"docs"`, an `https` URL with no user or password, `Home.DocsUrl`). ChatApi reads the home from what GitHub says of the repository at its newest commit (`GET …/about`'s `home`, through the about route's own read and the answer it keeps for every data center, [About](repo.md#about)), so docs work before anyone clones it. When the repository's own home names none, Smithers' curated home for it (`worker/home/curated/`) may (`"docs"` beside `sections`). When GitHub can't answer, a curated home's docs still serve.

The index is the docs site's [`llms.txt`](https://llmstxt.org): a `#` title, a `>` summary and `##` sections listing `- [Title](url): description`. `Docs.parse` reads it against the URL the repository named, keeping only links on that origin.

## ChatApi

`worker/docs/Api.ts`, routed by `worker/ChatApiProgram.ts` before RepoApi's reads, over the `DocsSource` service (`worker/docs/Source.ts`). Open to everyone, like the about read.

| Route | Answers |
|---|---|
| `GET /api/repos/<owner>/<name>/docs` | `200 { title, summary?, pages: [{ title, path, description?, section? }] }`: every page in the index's order, at most 500 |
| `GET …/docs?q=<query>` | the same with the pages `Docs.search` matches, best first, at most 8; an empty or blank query is the whole index; over 200 characters is `400 invalid` |
| `GET …/docs/page?path=/x.md` | `200 { title, path, url, text }`: one page the index lists, and its Markdown |

Both answer `Cache-Control: public, max-age=60`. Refusals are `{ code }`:

| Status | `code` | When |
|---|---|---|
| 404 | `no_docs` | neither the repository's home nor a curated one names docs, or its home isn't one |
| 404 | `not_found` | GitHub has no such public repository, or the name isn't one |
| 404 | `page_not_found` | the index lists no page at that path |
| 400 | `invalid` | a query over 200 characters; a path that doesn't start with `/` or is over 1,024 characters |
| 502 | `docs_unreachable` + `reason` | the docs site didn't answer as one: `Docs.fetchText`'s `unreachable`, `timeout`, `status` (a 4xx), `content`, `too_large` (a page over 512 KiB, never cut), `redirects` (too many, or one that ends on another site: its text is never kept as the docs site's), `private_host`, `invalid_url`; and `busy`, a 429 or 5xx the site may not answer next time |
| 503 | `unavailable` | GitHub can't say where the docs are and no curated home names them; `Retry-After: 5` |
| 405 | | any method but `GET` |

- **Never an arbitrary URL (SSRF).** A request names a path, never a URL. ChatApi fetches a page only when the repository's own index lists that path (`Docs.find`), and the index keeps only links on the origin the repository named. Every request goes through `Docs.fetchText`'s guard: no IP literals, local names or credentials, on every redirect; 8 s; no cookie.
- **Kept briefly.** The index and each page are kept for `DOCS_KEPT` (5 minutes) in the Worker's `repo` cache, by URL, in windows of that length. A refusal is never kept.

## The docs view

A `docs` view is a conversation row like a web page's (`views`, [web pages](web-pages.md#the-views-table)); migration `0043_docs_views` adds the template.

- **The write names a page, never its Markdown.** `POST /api/views { id, template: "docs", props: { url, title, repository: "owner/name", path } }`. ChatApi reads that page from that repository's index (`DocsSource.page`) and keeps the index's URL and title and at most 64 KiB of the Markdown, cut between characters and marked `truncated`. Markdown in the write is dropped, so a row never holds Markdown a client chose, and every device shows the page offline.
- **The same page again is the same view.** A resend of the id with the same repository and path answers `200`, whatever the site's text says now, and without asking the site, so a resend whose answer was lost lands even once the page is gone; another page under that id is `409`.
- **Refusals.** `400 invalid` without a repository GitHub could have or a path; `400 refused` for a page the index doesn't list, docs the repository doesn't have, or a site on the app's own origin; `502 docs_unreachable`; `503 unavailable`. The rest are the views route's.
- **Rendering.** `ConversationView` renders `DocsPageView` inline (`data-template="docs"`): the site's origin, **Full screen** and **Open on site**, the title and the Markdown, its relative links resolved against the page. `/app/views/<id>` shows it at full size. Markdown is someone else's text: `@smthrs/ui`'s Markdown renders no HTML and loads no image.
- The device keeps `views` at version 3 (`src/device/registry.ts`).

## The flow

`app/docs/search { repository, query, pages?, conversationId? }` (`src/features/docs/flows.ts`, steps in `src/features/docs/steps.ts`), model-invocable, placed on the client. Its description tells the agent to use it whenever the person asks about a repository's docs, VibeLang's (`smithersai/vibelang`) for one. A person runs it with `/docs <owner/name> <query>` (Member and above); the tab pins the conversation it shows.

| Step | Does |
|---|---|
| `app/docs/plan` | sealed: checks `owner/name` and picks one view id per page to show (`pages`, 1 to 3, default 1), so a run resumed after a crash adds the very views it chose before. Fails `DocsSearchRefused { reason: "invalid" }` |
| `app/docs/find` | `GET …/docs?q=` through `DocsClient`; answers the best `pages`. `no_docs` and `not_found` are `DocsSearchRefused` by that reason; a docs site that answers but not with an index is `unreadable`, except a busy one (`busy`), which is tried again; anything else is `DocsUnavailable`, which the retry policy (`DOCS_RETRY`: 500 ms doubling to 8 s, for 2 minutes) tries again |
| `app/docs/show` | for each page: `GET …/docs/page`, then `POST /api/views` with the plan's id. A page the index no longer lists, or the site no longer serves, is left out. `401` or `403` is `DocsForbidden` |

It answers `{ pages: [{ title, path, url, viewId }], text? }`: the pages shown, best first, none when nothing matched, and `text`, each shown page's Markdown (at most 12 KiB of each) for the agent to answer from. An agent's call adds its views to its answer's conversation; a person's to the one their tab pinned (`src/features/views/conversation.ts`, shared with `app/web/open`).

## The Docs tab

`/$owner/$repo/docs` lists the repository's docs; `/$owner/$repo/docs/<path>` shows one page (the splat is the page's path without its leading slash, such as `error-management/018-retrying.md`). The **Repository pages** navigation, beside **Home** and **Code**, has **Docs** only when the repository's home, or its curated one, names docs (`HomePage.docs`, `tabsOf`): its own home's `docs` at its newest commit, from what GitHub says of it, which the page loads cloned or not, else the curated home's, from ChatApi's answer. Both live in the tab's `home-current` row only, never in a stored home, so the Docs tab needs the network, as the docs themselves do. The page has a `Search docs` searchbox whose matches show as you type, the index's pages as links grouped by section, and the chosen page in the `Docs` region, rendered by `DocsPageView`. Its state lives in `src/features/docs/` as local TanStack DB collections and Effect actions ([state](../state.md)).

## Observability

No record carries a query, a path, a URL, a title or a page's text.

| Record | Where | Fields |
|---|---|---|
| `repo.docs`, `repo.docs.page` | ChatApi: log and span per request; Warn 5xx | `outcome` (`ok` or the refusal's code, `method`), `status`, `durationMs`, `results`, `searched`, `source` (`declared`, `curated`), `cached`, `characters`, `reason`; the span's `smithers.docs.outcome` |
| `smithers_docs_requests` | ChatApi counter | `route` (`index`, `page`), `status` |
| `docs.source` | ChatApi: Warn | `errorCode`, when reading docs failed for a reason that isn't an answer |
| `Docs.fetchText` | span (`@smthrs/views`) | outcome and status |
| `chat.view.add` | ChatApi | for a `docs` view also `truncated`, and `reason` (the docs refusal's code) |
| `docs.search` | the engine worker: log per settled search and failed step, span per step; Warn on a failure | `door` (`agent`, `person`), `outcome` (`shown`, `none`, `refused`, `forbidden`, `unavailable`), `reason`, `results`, `shown`, `feature: docs`; spans `smithers.docs.outcome`, `smithers.docs.results`, `smithers.docs.shown` |
| `smithers_web_docs_searches`, `smithers_web_docs_shown` | counters | `door`, `outcome`; `door` |

`DOCS_TELEMETRY` (`src/features/docs/contract.ts`) adds the browser's to the relay's allowlist.

## Tests

| Test | Proves |
|---|---|
| `worker/docs/Api.test.ts` | both routes through RepoApi's harness with the scripted GitHub and outside web: the repository's own home's index, signed out, kept and asked again past `DOCS_KEPT`; search and its bounds; the curated fallback, and GitHub down with and without one; every refusal; a page outside the index, another site or a URL never fetched; a page over 512 KiB refused; no query, path, URL, title or text in any record |
| `worker/Views.test.ts` "a docs view" | the page as the index lists it, never the writer's Markdown; a resend after the site changed, dropped the page or went down; 64 KiB cut between characters; every refusal |
| `src/features/docs/search.test.ts` | the steps on the Node host's engine against ChatApi's real routes: one page and three, a lost page left out, text bounded, nothing matched, refusals, passing failures tried again, conversations by door, records; the agent's `ctx.call` as a journaled step whose answer carries the page's text; the client |
| `src/features/views/views.test.ts` | `/docs` on a Node device shows the page inline with its Markdown and at full size |
| `db/Database.test.ts` "0043_docs_views" | the template's check |
| `e2e/docs.spec.ts` | on `smithersai/vibelang`, live: a visitor's Docs tab lists vibelang.sh's index, `Search docs` finds "Retrying" as they type, and the page renders with its site; `/docs` shows it in the chat and at full size; with the real model (`requires("liveModel")`), the agent asked how to retry shows a docs page |

Run them with the compose Postgres and Electric up: `pnpm exec vitest run worker/docs worker/Views.test.ts src/features/docs src/features/views`, and `pnpm exec playwright test e2e/docs.spec.ts` against `pnpm dev`.

## Plugin

The feature is self-contained, as a first-party plugin will be once the plugin host lands ([decision 0017](../decisions/0017-everything-is-a-plugin.md)): a docs source a repository declares (its home), ChatApi's docs routes, the `docs` card, the flow and its `/docs` command, and the Docs tab. `src/features/docs/plugin.json` declares those contributions; until the loader exists, the app wires them explicitly.
