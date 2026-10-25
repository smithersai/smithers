import { githubList } from "../../features/repo/scope"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { EmptyState, IssuesView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate, useParams } from "@tanstack/react-router"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useIssues } from "../../features/issues/components/IssuesContext"
import { NOT_FOUND } from "../../features/issues/contract"
import { syncsHere } from "../../features/issues/view"
import { usePulls } from "../../features/pulls/components/PullsContext"
import { listPageOf, pullAccessOf } from "../../features/pulls/view"
import "./pulls-screen.css"

// /$owner/$repo/pulls: the repository's pull requests, newest first, each with its state (Open, Draft, Merged, Closed).
// Unknown counts until the repository's first complete sync; sign-in, or Not found, for a person who may not read them. The
// route's loader opens the repository (`open`); this screen only renders what the device has.
export function PullsScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/pulls" })
  const { queries } = usePulls()
  const issues = useIssues()
  const { data: rows, isReady } = useLiveQuery(queries.list)
  const { data: synced } = useLiveQuery(issues.queries.synced)
  const { data: access } = useLiveQuery(issues.queries.access)
  const { data: unsynced } = useLiveQuery(issues.queries.unsynced)
  const { data: view } = useLiveQuery(queries.view)
  const navigate = useNavigate()
  const page = listPageOf(rows ?? [], { owner, name: repo }, synced, pullAccessOf(access, view), isReady)
  // Where this deployment doesn't sync the repository's pull requests, GitHub lists them (decision 0079 slice 1b).
  if (!syncsHere(access, unsynced)) {
    const list = githubList(owner, repo, "pulls")
    return <main className="issues-screen" aria-label="Pull requests"><RepoHeader /><HomeTabs /><p><a href={list.href}>{list.text}</a></p></main>
  }
  if (page.refused === "sign_in") return <main className="pulls-screen" aria-label="Pull requests"><RepoHeader /><HomeTabs /><SignInButton /></main>
  if (page.refused === "forbidden") {
    return <main className="pulls-screen" aria-label="Pull requests"><RepoHeader /><HomeTabs /><EmptyState title={NOT_FOUND} /></main>
  }
  return (
    <main className="pulls-screen" aria-label="Pull requests"><RepoHeader /><HomeTabs />
      <IssuesView
        repo={`${owner}/${repo}`}
        size="full"
        issues={page.pulls}
        loading={page.loading}
        unknown={page.unknown}
        emptyTitle="No pull requests"
        href={(pull) => ("href" in pull ? (pull.href as string) : undefined)}
        onNavigate={(_, href) => void navigate({ href })}
      />
    </main>
  )
}
