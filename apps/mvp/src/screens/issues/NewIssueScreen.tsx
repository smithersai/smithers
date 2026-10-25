import { ownRepository } from "../../features/auth/viewer"
import { githubList } from "../../features/repo/scope"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { EmptyState, IssueForm } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate, useParams } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useIssues } from "../../features/issues/components/IssuesContext"
import { issuesPath } from "../../features/issues/contract"
import { draftOf, mayWrite } from "../../features/issues/view"
import "./issues-screen.css"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"

// /$owner/$repo/issues/new: the new-issue form over the repository's draft, kept on the device. Create issue runs
// `issue/create` and goes back to the list, where the issue shows Requested until GitHub numbers it. A person who may
// not open one gets sign-in instead.
export function NewIssueScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/issues/new" })
  const { queries, actions } = useIssues()
  const auth = useAuth()
  const { data: view } = useLiveQuery(queries.view)
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const answer = useRepoAnswer(owner, repo)
  const navigate = useNavigate()
  if (!ownRepository(answer)) {
    const list = githubList(owner, repo, "issues")
    return <main className="issues-screen" aria-label="New issue"><RepoHeader /><HomeTabs /><p><a href={list.href + "/new"}>{"Open an issue on GitHub"}</a></p></main>
  }
  if (session === undefined) return <main className="issues-screen" aria-label="New issue"><RepoHeader /><HomeTabs /></main>
  const draft = draftOf(view)
  return (
    <main className="issues-screen" aria-label="New issue"><RepoHeader /><HomeTabs />
      {mayWrite(session, confirmed, answer)
        ? (
          <IssueForm
            title={draft.title}
            body={draft.body}
            error={draft.error}
            disabled={view?.submitting === true}
            onTitle={(title) => actions.setNewTitle(owner, repo, title)}
            onBody={(body) => actions.setNewBody(owner, repo, body)}
            onSubmit={() => {
              if (actions.create(owner, repo)) void navigate({ href: issuesPath(owner, repo) })
            }}
          />
        )
        : session.status === "signed_in" ? <EmptyState title="You can’t open issues in this repository." /> : <SignInButton />}
    </main>
  )
}
