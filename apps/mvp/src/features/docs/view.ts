import { DOCS_UNREADABLE, docsHref, NO_DOCS, NO_MATCHES, PAGE_UNREADABLE } from "./contract"
import type { CurrentRow, IndexRow, PageRow, SearchRow } from "./rows"
import type { ListedPage } from "./schema"

// What the Docs tab shows, worked out from its rows. Pure: React renders what these answer.

/** Pages under one section's heading, in the index's order; `section` is `null` for pages before any section. */
export interface Group {
  readonly section: string | null
  readonly pages: ReadonlyArray<ListedPage>
}

/** The index's pages by section, each section where its first page is. */
export const groupsOf = (pages: ReadonlyArray<ListedPage>): ReadonlyArray<Group> => {
  const groups: Array<{ section: string | null; pages: Array<ListedPage> }> = []
  for (const page of pages) {
    const section = page.section ?? null
    const group = groups.find((each) => each.section === section)
    if (group === undefined) groups.push({ section, pages: [page] })
    else group.pages.push(page)
  }
  return groups
}

/** The list beside the page: the index by section, or while the searchbox holds words, its matches. */
export type DocsList =
  | { readonly kind: "index"; readonly groups: ReadonlyArray<Group> }
  | { readonly kind: "results"; readonly pages: ReadonlyArray<ListedPage>; readonly notice: string | null }

/** The chosen page: on its way, its Markdown, or why not. */
export type ShownPage =
  | { readonly kind: "loading" }
  | { readonly kind: "text"; readonly title: string; readonly url: string; readonly text: string }
  | { readonly kind: "refused"; readonly notice: string }

/** The routed docs page: nothing yet, why there are no docs, or the docs with their list and the chosen page. */
export type DocsPage =
  | { readonly kind: "loading" }
  | { readonly kind: "refused"; readonly notice: string }
  | {
    readonly kind: "docs"
    readonly owner: string
    readonly name: string
    readonly title: string
    readonly summary: string | null
    readonly query: string
    readonly list: DocsList
    /** The page the route names, `null` on the index. */
    readonly page: ShownPage | null
    /** The chosen page's path, so its link in the list says it is the one shown. */
    readonly path: string | null
  }

/** The query's row: the current row, with what this tab read of its index, page and search. */
export interface DocsRow {
  readonly current: CurrentRow
  readonly index?: IndexRow | undefined
  readonly page?: PageRow | undefined
  readonly search?: SearchRow | undefined
}

const shownPage = (row: PageRow | undefined): ShownPage =>
  row === undefined || row.state === "loading"
    ? { kind: "loading" }
    : row.state === "refused"
    ? { kind: "refused", notice: PAGE_UNREADABLE }
    : { kind: "text", title: row.title, url: row.url, text: row.text }

const listOf = (current: CurrentRow, index: IndexRow, search: SearchRow | undefined): DocsList => {
  if (current.searchKey === null) return { kind: "index", groups: groupsOf(index.pages) }
  // A search on its way keeps the list as it was until its answer: no flash of "No matches".
  if (search === undefined || search.state === "loading") return { kind: "results", pages: [], notice: null }
  if (search.state === "refused") return { kind: "results", pages: [], notice: DOCS_UNREADABLE }
  return { kind: "results", pages: search.pages, notice: search.pages.length === 0 ? NO_MATCHES : null }
}

/** What the routed docs page shows, from the query's row. */
export const docsPageOf = (row: DocsRow | undefined): DocsPage => {
  if (row === undefined || row.current.repoKey === "" || row.index === undefined || row.index.state === "loading") {
    return { kind: "loading" }
  }
  const { current, index } = row
  if (index.state === "refused") return { kind: "refused", notice: index.code === "no_docs" ? NO_DOCS : DOCS_UNREADABLE }
  return {
    kind: "docs",
    owner: current.owner,
    name: current.name,
    title: index.title,
    summary: index.summary,
    query: current.query,
    list: listOf(current, index, row.search),
    page: current.pageKey === null ? null : shownPage(row.page),
    path: current.path,
  }
}

/**
 * Where a link in the shown page goes in the app: another page of the same index, on the shown page's own site, opens
 * as this tab's docs page; section links and anything else stay on the site, `undefined`.
 */
export const inAppHref = (
  href: string,
  docs: { readonly owner: string; readonly name: string; readonly pageUrl: string; readonly pages: ReadonlyArray<ListedPage> },
): string | undefined => {
  const target = URL.parse(href)
  const site = URL.parse(docs.pageUrl)
  if (target === null || site === null || target.origin !== site.origin || target.hash !== "") return undefined
  return docs.pages.some((page) => page.path === target.pathname)
    ? docsHref(docs.owner, docs.name, target.pathname)
    : undefined
}
