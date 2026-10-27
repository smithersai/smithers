import { githubList } from "../../features/repo/scope"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { Button, EmptyState } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Navigate, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useIssues } from "../../features/issues/components/IssuesContext"
import { issuePath } from "../../features/issues/contract"
import { draftOf, mayWrite, syncsHere } from "../../features/issues/view"
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
  const { data: writes } = useLiveQuery(queries.writes)
  const { data: rows } = useLiveQuery(queries.list)
  const writeId = search.write ?? view?.createdWriteId
  const created = writes?.find((write) => write.id === writeId && write.repoId === `github/${owner}/${repo}` && write.op === "issue/create")
  const notSent = rows?.some((row) => row.id === writeId && row.pending === "not_sent") === true || created?.status === "failed" || created?.status === "refused"
  // Where this deployment doesn't sync the repository's issues, it can't show a new one arriving: GitHub opens it.
  if (!syncsHere(access, unsynced)) {
    const list = githubList(owner, repo, "issues")
    return <main className="issues-screen" aria-label="New issue"><RepoHeader /><HomeTabs /><p><a href={list.href + "/new"}>{"Open an issue on GitHub"}</a></p></main>
  }
  if (session === undefined) return <main className="issues-screen" aria-label="New issue"><RepoHeader /><HomeTabs /></main>
  if (writeId !== undefined && search.write === undefined) return <Navigate to="/$owner/$repo/issues/new" params={{ owner, repo }} search={{ write: writeId }} replace />
  if (created?.status === "done" && created.itemNumber !== null) return <Navigate to={issuePath(owner, repo, created.itemNumber)} replace />
  if (writeId !== undefined) return (
    <main className="issues-screen" aria-label="New issue"><RepoHeader /><HomeTabs />
      {session.status === "signed_out" ? <SignInButton /> : notSent
        ? <EmptyState title="Not sent" action={<Button onClick={() => {
          const href = actions.edit(writeId)
          if (href !== undefined) void navigate({ href })
        }}>Edit</Button>} />
        : <p role="status">Creating issue…</p>}
    </main>
  )
  const draft = draftOf(view)
  return (
    <main className="issues-screen" aria-label="New issue"><RepoHeader /><HomeTabs />
      {mayWrite(session, confirmed, answer)
        ? (
          <NewIssueForm
            title={draft.title}
            body={draft.body}
            error={draft.error}
            disabled={view?.submitting === true}
            onTitle={(title) => actions.setNewTitle(owner, repo, title)}
            onBody={(body) => actions.setNewBody(owner, repo, body)}
            onSubmit={() => { actions.create(owner, repo) }}
          />
        )
        : session.status === "signed_in" ? <EmptyState title="You can’t open issues in this repository." /> : <SignInButton />}
    </main>
  )
}
