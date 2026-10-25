import { useRepo } from "../../features/repo/components/RepoContext"
import { githubList, isDeploymentRepository } from "../../features/repo/scope"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { Badge, Button, EmptyState, IssuesView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useIssues } from "../../features/issues/components/IssuesContext"
import { useTodos } from "../../features/todos/components/TodosContext"
import { mayChange, todosByIssue, withTodos } from "../../features/todos/view"
import {
  DISCARD,
  EDIT,
  ENABLE_TRIAGE,
  issuePath,
  NEW_ISSUE,
  NOT_FOUND,
  PAUSE_TRIAGE,
  TRIAGE_OFF,
} from "../../features/issues/contract"
import { COMMITMENTS, COMMITMENT_COPY, filterCommitment } from "../../features/issues/lifecycle"
import { listProps, mayManageTriageOnList, mayWrite, triageSwitchOf } from "../../features/issues/view"
import { BackToChat } from "../../features/views/components/BackToChat"
import "./issues-screen.css"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"

// /$owner/$repo/issues: the repository's issues, this device's own new ones first with their chip, each with its triage
// chip and the TODOs made from it, Make TODO in its menu for a Member (docs/features/todos.md#from-an-issue), New issue
// for a person who may open one, and Enable triage or Pause triage for a Maintainer once this repository's issue sync is complete. A repository whose issues this person may not read shows sign-in, or Not found. A new issue that wasn't sent gets Edit, back to the form, and Discard. The route's loader
// opens the repository (`open`); this screen only renders what the device has.
export function IssuesScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/issues" })
  const { data: repository } = useLiveQuery(useRepo().queries.view)
  const { queries, actions } = useIssues()
  const auth = useAuth()
  const { data: rows } = useLiveQuery(queries.list)
  const { data: synced } = useLiveQuery(queries.synced)
  const { data: access } = useLiveQuery(queries.access)
  const { data: triage } = useLiveQuery(queries.triage)
  const { data: triagePending } = useLiveQuery(queries.triagePending)
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const answer = useRepoAnswer(owner, repo)
  const todos = useTodos()
  const { data: todosView } = useLiveQuery(todos.queries.view)
  const todosRepoId = todosView?.repoId ?? ""
  const { data: todoRows } = useLiveQuery(todos.queries.stack(todosRepoId).todos)
  const navigate = useNavigate()
  const search = useSearch({ from: "/$owner/$repo/issues" })
  const list = listProps(filterCommitment(rows ?? [], search.commitment), synced, access, triage !== undefined && !triage.paused)
  const triageSwitch = triageSwitchOf(triage, triagePending ?? [])
  // The full-screen size of the repository's issues view in the chat (ruling FE-9): Back to chat minimizes it.
  const back = <BackToChat target={{ template: "issues", props: { repo: `${owner}/${repo}` } }} />
  if (!isDeploymentRepository(owner, repo, repository?.about)) {
    const list = githubList(owner, repo, "issues")
    return <main className="issues-screen" aria-label="Issues">{back}<RepoHeader /><HomeTabs /><p><a href={list.href}>{list.text}</a></p></main>
  }
  // A repository whose issues this person may not read: sign in, or nothing to show.
  if (list.refused === "sign_in") return <main className="issues-screen" aria-label="Issues">{back}<RepoHeader /><HomeTabs /><SignInButton /></main>
  if (list.refused === "forbidden") {
    return <main className="issues-screen" aria-label="Issues">{back}<RepoHeader /><HomeTabs /><EmptyState title={NOT_FOUND} /></main>
  }
  return (
    <main className="issues-screen" aria-label="Issues">{back}<RepoHeader /><HomeTabs />
      <nav aria-label="Commitment">
        {[undefined, ...COMMITMENTS].map((commitment) => (
          <Button key={commitment ?? "all"} variant={search.commitment === commitment ? "secondary" : "ghost"} size="sm" asChild>
            <Link to="/$owner/$repo/issues" params={{ owner, repo }} search={{ commitment }} aria-current={search.commitment === commitment ? "page" : undefined}>
              {commitment === undefined ? "All" : COMMITMENT_COPY[commitment]}
            </Link>
          </Button>
        ))}
      </nav>
      <IssuesView
        repo={`${owner}/${repo}`}
        size="full"
        issues={withTodos(
          list.issues,
          todosByIssue(todosRepoId, todoRows, owner, repo),
          session !== undefined && mayChange(session, confirmed, answer),
          (number) => void navigate({ href: todos.actions.fromIssue(owner, repo, number) }),
        )}
        unknown={list.unknown}
        href={(issue) => (issue.number === null ? undefined : issuePath(owner, repo, issue.number))}
        onNavigate={(_, href) => void navigate({ href })}
        actions={session !== undefined && mayWrite(session, confirmed, answer)
          ? (
            <>
              {mayManageTriageOnList(session, confirmed, answer, synced) && session.hostedModel === false
                ? <Button variant="outline" disabled data-triage-off="">{TRIAGE_OFF}</Button>
                : mayManageTriageOnList(session, confirmed, answer, synced)
                ? (
                  <Button
                    variant="outline"
                    disabled={triageSwitch.disabled}
                    onClick={() =>
                      triageSwitch.action === "enable"
                        ? actions.enableTriage(owner, repo)
                        : actions.pauseTriage(owner, repo)}
                  >
                    {triageSwitch.action === "enable" ? ENABLE_TRIAGE : PAUSE_TRIAGE}
                  </Button>
                )
                : null}
              <Button asChild>
                <Link to="/$owner/$repo/issues/new" params={{ owner, repo }}>{NEW_ISSUE}</Link>
              </Button>
            </>
          )
          : undefined}
      />
      {list.notSent.length === 0 ? null : (
        <ul className="issues-not-sent" aria-label="Not sent">
          {list.notSent.map((write) => (
            <li key={write.id} className="issues-not-sent-row">
              <span className="issues-not-sent-title">{write.title}</span>
              {write.reason === undefined ? null : <Badge variant="destructive">{write.reason}</Badge>}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const to = actions.edit(write.id)
                  if (to !== undefined) void navigate({ href: to })
                }}
              >
                {EDIT}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => actions.discard(write.id)}>{DISCARD}</Button>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
