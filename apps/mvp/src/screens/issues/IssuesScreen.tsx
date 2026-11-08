import { IssueSearchBox } from "../../features/issues/components/IssueSearchBox"
import { IssueSort } from "../../features/issues/components/IssueSort"
import { awaitingListRows, visibleRows, withSearched } from "../../features/issues/list"
import { githubList } from "../../features/repo/scope"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { Badge, Button, Card, CardContent, EmptyState, IssuesView, LinkTabs, PageBody } from "@smthrs/ui"
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
import { filterWork, withWork, workByIssue } from "../../features/issues/workView"
import { WORK_FILTER_LABEL } from "../../features/issues/work"
import { listFailureOf, type ListRow, listProps, listSyncOf, mayManageTriageOnList, mayWrite, syncsHere, triageSwitchOf } from "../../features/issues/view"
import "./issues-screen.css"
import { useRepo, useRepoAnswer } from "../../features/repo/components/RepoContext"
import { usePersonalModel } from "../../features/personal-model/components/PersonalModelContext"
import { repoId } from "../../features/repo/contract"
import { SETTLED, SLOT } from "../../firstPaint/settled"

// /$owner/$repo/issues: the repository's issues, this device's own new ones first with their chip, each with its triage
// chip and the TODOs made from it, Make TODO in its menu for a Member (docs/features/todos.md#from-an-issue), New issue
// for a person who may open one, and Enable triage or Pause triage for a Maintainer once this repository's issue sync is complete. A repository whose issues this person may not read shows sign-in, or Not found. A new issue that wasn't sent gets Edit, back to the form, and Discard. The route's loader
// opens the repository (`open`); this screen only renders what the device has.
export function IssuesScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/issues" })
  const { queries, actions } = useIssues()
  const auth = useAuth()
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: privateRows, isReady: privateReady } = useLiveQuery(queries.list)
  const { data: publicRows, isReady: publicReady } = useLiveQuery(queries.publicList)
  const rows = session?.status === "signed_out" ? publicRows : privateRows
  const isReady = session?.status === "signed_out" ? publicReady : privateReady
  const { data: synced } = useLiveQuery(queries.synced)
  const { data: workRows } = useLiveQuery(queries.work)
  const work = workByIssue(workRows ?? [])
  const { data: access } = useLiveQuery(queries.access)
  const { data: unsynced } = useLiveQuery(queries.unsynced)
  const { data: triage } = useLiveQuery(queries.triage)
  const { data: triagePending } = useLiveQuery(queries.triagePending)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  // Triage judges on its enabler's model (ruling AUTH-8): a person with a model of their own may enable it.
  const { data: ownModels } = useLiveQuery(usePersonalModel().queries.saved)
  const own = (ownModels?.length ?? 0) > 0
  const answer = useRepoAnswer(owner, repo)
  const repository = useRepo()
  const { data: roles } = useLiveQuery(repository.queries.roles)
  const todos = useTodos()
  const { data: todosView } = useLiveQuery(todos.queries.view)
  const todosRepoId = todosView?.repoId ?? ""
  const { data: todoRows } = useLiveQuery(todos.queries.stack(todosRepoId).todos)
  const navigate = useNavigate()
  const search = useSearch({ from: "/$owner/$repo/issues" })
  const list = listProps(rows ?? [], synced, access, triage !== undefined && !triage.paused)
  const { data: searched } = useLiveQuery(queries.searched)
  const failure = listFailureOf(access, roles?.find((row) => row.id === repoId(owner, repo))?.failure)
  const listSync = listSyncOf(list.unknown, isReady, access)
  // Until the list has synced, the issues route answers a search; once it has, the device's own rows do.
  const searchable = listSync === "syncing" ? withSearched(rows ?? [], searched?.[0], repoId(owner, repo), search.q) : rows ?? []
  const visible = listProps(visibleRows(filterWork(filterCommitment(searchable as ReadonlyArray<ListRow>, search.commitment), work, search.work), search), synced, access, triage !== undefined && !triage.paused).issues
  // A query alone is not a settled answer: retain the gated shell until this search answers or sync wins.
  const awaitingRows = awaitingListRows({ syncing: listSync === "syncing", failed: failure !== undefined,
    rows: visible.length, filtered: search.commitment !== undefined || search.work !== undefined || search.sort !== undefined,
    repoId: repoId(owner, repo), q: search.q, searched: searched?.[0],
  })
  const triageSwitch = triageSwitchOf(triage, triagePending ?? [])
  // The full-screen size of the repository's issues view in the chat (ruling FE-9): Back to chat minimizes it.
  const header = <RepoHeader backTarget={{ template: "issues", props: { repo: `${owner}/${repo}` } }} />
  // Where this deployment doesn't sync the repository's issues, GitHub lists them (decision 0079 slice 1b).
  if (!syncsHere(access, unsynced)) {
    const list = githubList(owner, repo, "issues")
    return (
      <main className="issues-screen" aria-label="Issues" {...SETTLED}>{header}
        <PageBody width="wide">
          <Card><CardContent><p className="issues-status-line"><a href={list.href}>{list.text}</a></p></CardContent></Card>
        </PageBody>
      </main>
    )
  }
  // A repository whose issues this person may not read: sign in, or nothing to show.
  if (list.refused === "sign_in") {
    return (
      <main className="issues-screen" aria-label="Issues" {...SETTLED}>{header}
        <PageBody width="wide">
          <Card className="issues-sign-in"><CardContent><SignInButton /></CardContent></Card>
        </PageBody>
      </main>
    )
  }
  if (list.refused === "forbidden") {
    return (
      <main className="issues-screen" aria-label="Issues" {...SETTLED}>{header}
        <PageBody width="wide">
          <Card><CardContent><EmptyState title={NOT_FOUND} /></CardContent></Card>
        </PageBody>
      </main>
    )
  }
  return (
    <main className="issues-screen" aria-label="Issues" {...(awaitingRows ? {} : SETTLED)}>{header}
      <PageBody width="wide">
        {failure === undefined ? null : (
          <Card><CardContent>
            <p role="status" className="issues-status-line"><span>{failure}</span>{" "}
              <Button variant="outline" size="sm" onClick={() => { repository.actions.retryAbout(owner, repo); repository.actions.role(owner, repo); actions.retry() }}>Try again</Button>{" "}
              <Button asChild variant="outline" size="sm"><a href={githubList(owner, repo, "issues").href}>Open on GitHub ↗</a></Button>
            </p>
          </CardContent></Card>
        )}
        <LinkTabs aria-label="Schedule" className="issues-schedule">
          <span className="issues-schedule-label">Schedule</span>
          {[undefined, ...COMMITMENTS].map((commitment) => (
            <Link
              key={commitment ?? "all"}
              to="/$owner/$repo/issues"
              params={{ owner, repo }}
              search={{ ...search, commitment }}
              aria-current={search.commitment === commitment ? "page" : undefined}
            >
              {commitment === undefined ? "All" : COMMITMENT_COPY[commitment]}
            </Link>
          ))}
        </LinkTabs>
        <LinkTabs aria-label="Work" className="issues-schedule">
          <span className="issues-schedule-label">Work</span>
          <Link to="/$owner/$repo/issues" params={{ owner, repo }} search={{ ...search, work: undefined }}
            aria-current={search.work === undefined ? "page" : undefined}>Any</Link>
          <Link to="/$owner/$repo/issues" params={{ owner, repo }} search={{ ...search, work: "pr-or-queue" }}
            aria-current={search.work === "pr-or-queue" ? "page" : undefined}>{WORK_FILTER_LABEL}</Link>
        </LinkTabs>
        {(
          <div className="list-search-tools" role="search" aria-label="Search issues">
            <IssueSearchBox owner={owner} repo={repo} q={search.q} />
            <IssueSort value={search.sort ?? "updated"}
              onChange={(sort) => void navigate({ to: "/$owner/$repo/issues", params: { owner, repo }, search: { ...search, sort }, resetScroll: false })} />
          </div>
        )}
        {(
          <IssuesView
            repo={`${owner}/${repo}`}
            size="full"
            issues={withTodos(
              withWork(visible, work),
              todosByIssue(todosRepoId, todoRows, owner, repo),
              session !== undefined && mayChange(session, confirmed, answer),
              (number) => void navigate({ href: todos.actions.fromIssue(owner, repo, number) }),
            )}
            // Until its rows are known the list shows no counts or loading state (the cold-path contract).
            unknown={listSync === "syncing"}
            href={(issue) => (issue.number === null ? undefined : issuePath(owner, repo, issue.number))}
            onNavigate={(_, href) => void navigate({ href })}
            actions={session !== undefined && mayWrite(session, confirmed, answer)
              ? (
                <>
                  {mayManageTriageOnList(session, confirmed, answer, synced, triageSwitch.action, own) && session.hostedModel === false && !own
                    ? <Button variant="outline" disabled data-triage-off="">{TRIAGE_OFF}</Button>
                    : mayManageTriageOnList(session, confirmed, answer, synced, triageSwitch.action, own)
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
                  <Button asChild variant="solid">
                    <Link to="/$owner/$repo/issues/new" params={{ owner, repo }}>{NEW_ISSUE}</Link>
                  </Button>
                </>
              )
              : undefined}
          />
        )}
        {awaitingRows ? <div {...SLOT} /> : null}
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
      </PageBody>
    </main>
  )
}
