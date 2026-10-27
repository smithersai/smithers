import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { Badge, Button, EmptyState, NotFound, ItemConversation, LinkTabs, RunList } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useParams } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useIssues } from "../../features/issues/components/IssuesContext"
import { pageOf } from "../../features/issues/view"
import { usePulls } from "../../features/pulls/components/PullsContext"
import { githubPullUrl, type PullTab, pullTabPath } from "../../features/pulls/contract"
import { ChangedFiles } from "../../features/pulls/components/ChangedFiles"
import { CommitList } from "../../features/pulls/components/CommitList"
import { checkRows, checksSummaryOf, conversationProps, mergeBoxOf, pullAccessOf } from "../../features/pulls/view"
import "./pulls-screen.css"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"

// /$owner/$repo/pull/$number and its tabs: one pull request. Conversation shows its body, comments and reviews (the
// review check's findings among them), with Merge for a Maintainer on an open pull request; Commits its commits; Checks
// the Smithers runs on its head; Files the files its base and head differ by. Merge is the person's own press, bound to
// the head and base this page shows; the page says Merging, then Merged, or why not. Beside Merge into the default
// branch, the page says merging deploys it (ruling GH-9).
export function PullScreen({ tab }: { readonly tab: PullTab }) {
  const { owner, repo, number } = useParams({ strict: false }) as { owner: string; repo: string; number: number }
  const { queries, actions } = usePulls()
  const auth = useAuth()
  const { data: pull, isReady: pullReady } = useLiveQuery(queries.pull)
  const { data: comments } = useLiveQuery(queries.comments)
  const { data: reviews } = useLiveQuery(queries.reviews)
  const { data: commits } = useLiveQuery(queries.commits)
  const { data: checks } = useLiveQuery(queries.checks)
  const { data: files } = useLiveQuery(queries.files)
  const { data: view } = useLiveQuery(queries.view)
  const { data: session } = useLiveQuery(auth.queries.session)
  const answer = useRepoAnswer(owner, repo)
  const issues = useIssues()
  const { data: synced, isReady: syncedReady } = useLiveQuery(issues.queries.synced)
  const { data: access } = useLiveQuery(issues.queries.access)
  // A pull request is an issue row of kind `pull`: shown, loading until the first complete sync, or not there.
  const pageAccess = pullAccessOf(access, view)
  const back = <Button asChild variant="ghost"><Link to="/$owner/$repo/pulls" params={{ owner, repo }}>Pull requests</Link></Button>
  const page = pageOf(pull, synced, pullReady && view?.installed === true, syncedReady, pageAccess)
  if (page === "sign_in") return <main className="pulls-screen"><RepoHeader />{back}<SignInButton /></main>
  if (page === "missing") return <main className="pulls-screen"><RepoHeader /><NotFound title="Pull request not found" back={back} /></main>

  if (page === "unknown") return (
    <main className="pulls-screen"><RepoHeader />{back}

      <EmptyState title="Pull request unavailable here" action={
        <>
          {pageAccess?.status === "unavailable" ? <Button variant="outline" onClick={actions.retry}>Try again</Button> : null}
          {" "}<Button asChild variant="outline"><a href={githubPullUrl(owner, repo, number)} target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a></Button>
        </>
      } />
    </main>
  )
  if (pull === undefined) return <main className="pulls-screen"><RepoHeader />{back}<p role="status">Syncing pull request…</p></main>
  const summary = checksSummaryOf(checks ?? [])
  const tabs: ReadonlyArray<{ readonly tab: PullTab; readonly label: string }> = [
    { tab: "conversation", label: "Conversation" },
    { tab: "commits", label: `Commits ${(commits ?? []).length}` },
    { tab: "checks", label: summary.total === 0 ? "Checks" : `Checks ${summary.passed}/${summary.total}` },
    { tab: "files", label: `Files ${pull.changedFiles}` },
  ]
  const box = mergeBoxOf(session, answer, pull, view)
  const header = (
    <div className="pull-merge">
      {pull.baseRef === "" ? null : (
        <span className="pull-refs" aria-label={`${pull.baseRef} from ${pull.headRef}`}>
          <code>{pull.baseRef}</code> ← <code>{pull.headRef}</code>
        </span>
      )}
      {summary.failed > 0 ? <Badge variant="destructive">{`${summary.failed} failed`}</Badge> : null}
      {box.notice === undefined
        ? null
        : <Badge variant={box.notice === "Merged" ? "success" : "outline"}>{box.notice}</Badge>}
      {box.warning === undefined ? null : <Badge variant="warning" role="note">{box.warning}</Badge>}
      {box.merge
        ? <Button onClick={() => void actions.merge(pull.headSha, pull.baseSha, pull.number)}>Squash and merge</Button>
        : null}
    </div>
  )
  const filesKey = `${pull.baseSha}...${pull.headSha}`
  const compared = (files ?? []).find((row) => row.id === filesKey)
  return (
    <main className="pulls-screen" aria-label={`Pull request ${pull.number}`}><RepoHeader />
      {back}
      {tab === "conversation" ? null : <h1>{pull.title} <span>#{pull.number}</span></h1>}
      <LinkTabs aria-label="Pull request">
        {tabs.map((entry) => (
          <Link
            key={entry.tab}
            to={pullTabPath(owner, repo, number, entry.tab)}
            // Exact: the conversation's path is the other tabs' prefix, so the router would mark it current on each.
            activeOptions={{ exact: true }}
            aria-current={entry.tab === tab ? "page" : undefined}
          >
            {entry.label}
          </Link>
        ))}
      </LinkTabs>
      {tab === "conversation"
        ? <ItemConversation {...conversationProps(pull, comments ?? [], reviews ?? [], { owner, name: repo })} headerActions={header} />
        : tab === "commits"
        ? (
          (commits ?? []).length === 0 ? <EmptyState title="No commits" /> : <CommitList commits={commits ?? []} />
        )
        : tab === "checks"
        ? <RunList runs={checkRows(checks ?? [])} now={Date.now()} empty={<EmptyState title="No checks" />} />
        : (
          <section aria-label="Files" aria-busy={compared?.status !== "ready"}>
            {compared === undefined || compared.status === "loading"
              ? null
              : compared.status === "failed"
              ? <EmptyState title="Couldn't load files" />
              : <ChangedFiles files={compared.files} />}
          </section>
        )}
    </main>
  )
}
