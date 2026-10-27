import { DocsPageView, EmptyState, Input, Skeleton } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useNavigate } from "@tanstack/react-router"
import { DOCS_REGION, DOCS_TAB, SEARCH_DOCS } from "../contract"
import type { ListedPage } from "../schema"
import { docsPageOf, inAppHref } from "../view"
import { useDocs } from "./DocsContext"

// `/$owner/$repo/docs[/<page>]`: a repository's docs. Beside the page, the searchbox and the index's pages by section,
// or the search's matches while the box holds words; the chosen page in the Docs region, rendered from its Markdown
// (`@smthrs/ui`'s `DocsPageView`). A link in it to another page of the same index opens here; any other opens the site.
export function DocsPage() {
  const { queries, actions } = useDocs()
  const navigate = useNavigate()
  const { data } = useLiveQuery(queries.docs)
  const page = docsPageOf(data)
  if (page.kind === "loading") return <Skeleton className="docs-page-loading" />
  if (page.kind === "refused") return <EmptyState className="docs-page-refused" title={page.notice} />
  const { owner, name } = page
  const link = (listed: ListedPage) => (
    <li key={listed.path}>
      <Link
        to="/$owner/$repo/docs/$"
        params={{ owner, repo: name, _splat: listed.path.replace(/^\/+/, "") }}
        aria-current={listed.path === page.path ? "page" : undefined}
      >
        {listed.title}
      </Link>
    </li>
  )
  return (
    <div className="docs-page">
      <nav className="docs-page-nav" aria-label={page.title === "" ? DOCS_TAB : page.title}>
        <Input
          type="search"
          aria-label={SEARCH_DOCS}
          placeholder={SEARCH_DOCS}
          value={page.query}
          onChange={(event) => actions.search(event.currentTarget.value)}
        />
        {page.list.kind === "results" ? (
          page.list.notice === null ? <ul className="docs-page-links">{page.list.pages.map(link)}</ul> : (
            <p className="docs-page-notice" role="status">{page.list.notice}</p>
          )
        ) : (
          page.list.groups.map((group) => (
            <section key={group.section ?? ""} className="docs-page-section">
              {group.section === null ? null : <p className="docs-page-section-title">{group.section}</p>}
              <ul className="docs-page-links">{group.pages.map(link)}</ul>
            </section>
          ))
        )}
      </nav>
      {page.page === null ? (
        <header className="docs-page-index">
          <h1>{page.title}</h1>
          {page.summary === null ? null : <p>{page.summary}</p>}
        </header>
      ) : (
        <section className="docs-page-shown" role="region" aria-label={DOCS_REGION}>
          {page.page.kind === "loading" ? <Skeleton className="docs-page-loading" /> : page.page.kind === "refused" ? (
            <EmptyState title={page.page.notice} />
          ) : (
            <DocsPageView
              title={page.page.title}
              url={page.page.url}
              text={page.page.text}
              size="full"
              headingLevel={1}
              onLinkClick={(href, event) => {
                const shown = page.page?.kind === "text" ? page.page.url : ""
                const inApp = inAppHref(href, { owner, name, pageUrl: shown, pages: data?.index?.pages ?? [] })
                const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1
                if (inApp !== undefined && !modified) {
                  const _splat = new URL(href).pathname.replace(/^\/+/, "")
                  void navigate({ to: "/$owner/$repo/docs/$", params: { owner, repo: name, _splat } })
                } else {
                  window.open(inApp ?? href, "_blank", "noopener,noreferrer")
                }
              }}
            />
          )}
        </section>
      )}
    </div>
  )
}
