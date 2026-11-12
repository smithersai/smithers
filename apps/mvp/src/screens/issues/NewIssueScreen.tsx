import { githubList } from "../../features/repo/scope"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, PageBody, Skeleton } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, Navigate, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useIssues } from "../../features/issues/components/IssuesContext"
import { issuePath, NEW_ISSUE } from "../../features/issues/contract"
import { createdOf, draftOf, mayWrite, syncsHere } from "../../features/issues/view"
import { NewIssueForm } from "../../features/issues/components/NewIssueForm"
import "./issues-screen.css"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"

// /$owner/$repo/issues/new: the new-issue form over the repository's draft, kept on the device. Create issue runs
// `issue/create`, keeps its queued write in the URL, and opens the new issue once GitHub numbers it. A person who may
// not open one gets sign-in instead.
export function NewIssueScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/issues/new" })
  const { queries, actions } = useIssues()
  const auth = useAuth()
  const { data: view } = useLiveQuery(queries.view)
  const { data: access } = useLiveQuery(queries.access)
  const { data: unsynced } = useLiveQuery(queries.unsynced)
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const answer = useRepoAnswer(owner, repo)
  const navigate = useNavigate()
  const search = useSearch({ from: "/$owner/$repo/issues/new" })
  const { data: writes, isReady: writesReady } = useLiveQuery(queries.writes)
  const { data: rows, isReady: rowsReady } = useLiveQuery(queries.list)
  const writeId = search.write ?? view?.createdWriteId
  const created = createdOf(writes, writeId, owner, repo)
  const unknown = created === undefined && rows?.some((row) => row.id === writeId) !== true
  const restored = writesReady && rowsReady
  const retryable = rows?.some((row) => row.id === writeId && row.pending === "not_sent" && row.reason === "") === true
  const notSent = view?.submitting !== true && (rows?.some((row) => row.id === writeId && row.pending === "not_sent") === true || created?.status === "failed" || created?.status === "refused")
  // Where this deployment doesn't sync the repository's issues, it can't show a new one arriving: GitHub opens it.
  if (!syncsHere(access, unsynced)) {
    const list = githubList(owner, repo, "issues")
    return (
      <main className="issues-screen" aria-label="New issue"><RepoHeader />
        <PageBody width="narrow">
          <Card><CardContent><p className="issues-status-line"><a href={list.href + "/new"}>{"Open an issue on GitHub"}</a></p></CardContent></Card>
        </PageBody>
      </main>
    )
  }
  if (session === undefined) return <main className="issues-screen" aria-label="New issue"><RepoHeader /><PageBody width="narrow" /></main>
  if (writeId !== undefined && search.write === undefined) return <Navigate to="/$owner/$repo/issues/new" params={{ owner, repo }} search={{ write: writeId }} replace />
  if (created?.status === "done" && created.itemNumber !== null) return <Navigate to={issuePath(owner, repo, created.itemNumber)} replace />
  if (writeId !== undefined) return (
    <main className="issues-screen" aria-label="New issue"><RepoHeader />
      <PageBody width="narrow">
        {session.status === "signed_out"
          ? <Card className="issues-sign-in"><CardContent><SignInButton /></CardContent></Card>
          : unknown && restored
          ? (
            <Card><CardContent>
              <EmptyState title="Request unavailable" action={<Button asChild><Link to="/$owner/$repo/issues" params={{ owner, repo }}>Issues</Link></Button>} />
            </CardContent></Card>
          )
          : notSent
          ? (
            <Card><CardContent>
              <EmptyState title="Not sent" action={<>{retryable ? <Button onClick={() => void actions.retryWrite(writeId)}>Retry</Button> : null}<Button onClick={() => void actions.edit(writeId).then((href) => {
                if (href !== undefined) void navigate({ href })
              })}>Edit</Button></>} />
            </CardContent></Card>
          )
          : (
            <Card><CardContent>
              <p role="status">{unknown ? "Syncing issue…" : "Requested"}</p>
              <div className="issues-loading" aria-hidden>
                <Skeleton className="issues-loading-title" />
                <Skeleton className="issues-loading-body" />
              </div>
            </CardContent></Card>
          )}
      </PageBody>
    </main>
  )
  const draft = draftOf(view)
  return (
    <main className="issues-screen" aria-label="New issue"><RepoHeader />
      <PageBody width="narrow">
        {mayWrite(session, confirmed, answer)
          ? (
            <Card>
              <CardHeader>
                <CardTitle>{NEW_ISSUE}</CardTitle>
              </CardHeader>
              <CardContent>
                <NewIssueForm
                  title={draft.title}
                  body={draft.body}
                  error={draft.error ?? (view?.submissionFailed === true ? "Not sent" : undefined)}
                  disabled={view?.submitting === true}
                  onTitle={(title) => actions.setNewTitle(owner, repo, title)}
                  onBody={(body) => actions.setNewBody(owner, repo, body)}
                  onSubmit={() => { void actions.create(owner, repo) }}
                />
              </CardContent>
            </Card>
          )
          : session.status === "signed_in"
          ? (
            <Card><CardContent>
              <EmptyState title="You can’t open issues in this repository." />
            </CardContent></Card>
          )
          : <Card className="issues-sign-in"><CardContent><SignInButton /></CardContent></Card>}
      </PageBody>
    </main>
  )
}
