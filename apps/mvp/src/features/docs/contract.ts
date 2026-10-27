import { REPOS_ROUTE } from "../repo/contract"
import { encodePath } from "../repo/paths"

// A repository's docs (ruling AGENT-6, docs/features/docs.md): the one home of the values the tab, the engine worker,
// ChatApi and the tests share. A repository names its docs in its home (`"docs"` in `.smithers/home.json`, an https
// `llms.txt` index); Smithers' curated home names them for a repository that can't. Nothing here is VibeLang's.

/** The last segment of {@link docsRoute}, and the app's `/$owner/$repo/docs` page. */
export const DOCS_SEGMENT = "docs"

/** The segment after {@link DOCS_SEGMENT} that reads one page. */
export const PAGE_SEGMENT = "page"

/**
 * `GET <route>[?q=<query>]`: the repository's docs index, every page in its order (at most {@link MAX_LISTED}), or the
 * pages that match `q`, best first (at most {@link SEARCH_LIMIT}).
 */
export const docsRoute = (owner: string, name: string, query?: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${DOCS_SEGMENT}` +
  (query === undefined || query === "" ? "" : `?q=${encodeURIComponent(query)}`)

/** `GET <route>`: one page of the repository's docs index, by its path, with its Markdown. */
export const docsPageRoute = (owner: string, name: string, path: string): string =>
  `${REPOS_ROUTE}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${DOCS_SEGMENT}/${PAGE_SEGMENT}` +
  `?path=${encodeURIComponent(path)}`

/** The longest query the docs route searches for. */
export const MAX_QUERY = 200

/** The longest page path the page route reads. */
export const MAX_PATH = 1024

/** The most pages a search answers. */
export const SEARCH_LIMIT = 8

/** The most pages the index answers in its order. */
export const MAX_LISTED = 500

/** The largest page the docs routes read from the docs site: 512 KiB. A larger one is refused, never cut. */
export const MAX_PAGE_BYTES = 512 * 1024

/** The largest Markdown a `docs` view keeps: 64 KiB, cut at a character and marked `truncated`. */
export const MAX_VIEW_TEXT_BYTES = 64 * 1024

/** The most pages one `app/docs/search` shows, and how many it shows unless asked. */
export const MAX_SHOWN = 3
export const DEFAULT_SHOWN = 1

/** The most of each shown page's Markdown `app/docs/search` answers the agent with: 12 KiB. */
export const AGENT_TEXT_BYTES = 12 * 1024

/**
 * Why the docs routes didn't answer, as `{ code }`: the repository declares no docs (`no_docs`), GitHub has no such
 * public repository (`not_found`), the index has no page at that path (`page_not_found`), the request isn't one
 * (`invalid`), the docs site didn't answer as a docs site should (`docs_unreachable`, with its `reason`), or the server
 * can't decide now (`unavailable`).
 */
export const DOCS_REFUSALS = ["no_docs", "not_found", "page_not_found", "invalid", "docs_unreachable", "unavailable"] as const
export type DocsRefusal = (typeof DOCS_REFUSALS)[number]

/** The Docs tab's words (product words, minimal text). */
export const DOCS_TAB = "Docs"
export const SEARCH_DOCS = "Search docs"
export const DOCS_REGION = "Docs"
export const NO_MATCHES = "No matches"
export const NO_DOCS = "No docs"
export const DOCS_UNREADABLE = "Couldn't read docs"
export const PAGE_UNREADABLE = "Page unavailable · choose from the list"

/** `/$owner/$repo/docs`, or one page of it: `/$owner/$repo/docs/<path without its leading slash>`. */
export const docsHref = (owner: string, name: string, path?: string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${DOCS_SEGMENT}` +
  (path === undefined ? "" : `/${encodePath(path.replace(/^\/+/, ""))}`)

/** A page's path from the route's splat: the splat with its leading slash. */
export const pathOfSplat = (splat: string | undefined): string | undefined =>
  splat === undefined || splat === "" ? undefined : `/${splat.replace(/^\/+/, "")}`

/**
 * What the docs feature records (docs/observability.md): ChatApi's routes, the flow's steps and the tab, by outcome.
 * Never a query, a path, a URL, a title or a page's text.
 */
export const DOCS_TELEMETRY = {
  records: [
    "docs.search",
    "docs.tab",
    "smithers_web_docs_searches",
    "smithers_web_docs_shown",
    "smithers_web_docs_tab",
  ],
  fields: [
    "kind",
    "outcome",
    "door",
    "results",
    "shown",
    "status",
    "durationMs",
    "smithers.docs.outcome",
    "smithers.docs.results",
    "smithers.docs.shown",
  ],
} as const
