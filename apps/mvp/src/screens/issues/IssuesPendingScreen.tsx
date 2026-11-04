import { PageBody, PageHeader } from "@smthrs/ui"
import { Link, useParams, useSearch } from "@tanstack/react-router"
import { IssueSearchBox } from "../../features/issues/components/IssueSearchBox"
import { SLOT } from "../../firstPaint/settled"
import "./issues-screen.css"

/**
 * `/$owner/$repo/issues` while its route still loads: the repository's name, the search box and the slot the first
 * paint's rows sit in, from the URL only. A search typed here asks the issues route at once (`IssueSearchBox`); the
 * list shows its answer once the route opens. On a cold page the route shows this as soon as the app renders
 * (router.tsx `FIRST_LOAD_PENDING_MS`), seconds before the list can.
 */
export function IssuesPendingScreen() {
  const params = useParams({ strict: false })
  const search = useSearch({ strict: false }) as { readonly q?: unknown }
  const owner = params.owner ?? ""
  const repo = params.repo ?? ""
  return (
    <main className="issues-screen" aria-label="Issues" aria-busy="true">
      <PageHeader
        className="repo-header"
        aria-label="Repository"
        width="wide"
        title={<Link to="/$owner/$repo" params={{ owner, repo }}>{owner} / {repo}</Link>}
      />
      <PageBody width="wide">
        <div className="list-search-tools" role="search" aria-label="Search issues">
          <IssueSearchBox owner={owner} repo={repo} q={typeof search.q === "string" ? search.q : undefined} ask pending />
        </div>
        <div {...SLOT} />
      </PageBody>
    </main>
  )
}
