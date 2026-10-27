import { OfflineFallback } from "../../features/navigation/components/OfflineFallback"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { Button, EmptyState, NotFound, ItemAsideSection, ItemConversation, Kbd, TriageControl } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { CommitmentControl } from "../../features/issues/components/CommitmentControl"
import { useIssues } from "../../features/issues/components/IssuesContext"
import { useTodos } from "../../features/todos/components/TodosContext"
import { MAKE_TODO, MAKE_TODO_KEY, TODO } from "../../features/todos/contract"
import { mayChange, mayMakeTodo, todosByIssue } from "../../features/todos/view"
import { DISCARD, EDIT, githubIssueUrl } from "../../features/issues/contract"
import {
  conversationProps,
  draftOf,
  mayManageTriage,
  mayTriage,
  mayWrite,
  pageOf,
  triageControlOf,
} from "../../features/issues/view"
import "./issues-screen.css"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"

// /$owner/$repo/issues/$number: one issue and its comments, this device's own last with their chip, "Open on GitHub ↗",
// its triage state with Accept, Not accepted and Run triage again for a Member and above, and the comment composer for a
// person who may comment. A comment that wasn't sent gets Edit, back to the composer,
// and Discard. A side column shows the TODOs made from it and, for a Member while none is open, Make TODO, which its
// key `t` also presses (docs/features/todos.md#from-an-issue). An answered shape with no first complete sync shows
// the GitHub link instead of waiting forever; only a complete sync establishes Not found.
// A repository whose issues this person may not read shows sign-in, or Not found. A cold item query remains loading
// until the eager shape finishes, even if its first 2xx already granted access.
export function IssueScreen() {
  const { owner, repo, number } = useParams({ from: "/$owner/$repo/issues/$number" })
  const { queries, actions } = useIssues()
  const auth = useAuth()
  const { data: item, isReady: itemReady } = useLiveQuery(queries.item)
  const { data: rows } = useLiveQuery(queries.conversation)
  const { data: synced, isReady: syncedReady } = useLiveQuery(queries.synced)
  const { data: view } = useLiveQuery(queries.view)
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
  const back = <Button asChild variant="ghost"><Link to="/$owner/$repo/issues" params={{ owner, repo }}>Issues</Link></Button>
  const page = pageOf(item, synced, itemReady, syncedReady, access)
  if (page === "sign_in") return <main className="issues-screen"><RepoHeader />{back}<SignInButton /></main>
  if (page === "missing") return <main className="issues-screen"><RepoHeader /><NotFound title="Issue not found" back={back} /></main>

  if (page === "unknown") return (
    <main className="issues-screen"><RepoHeader />{back}

      <EmptyState title="Issue unavailable here" action={
        <>
          {access?.status === "unavailable" ? <Button variant="outline" onClick={actions.retry}>Try again</Button> : null}
          {" "}<Button asChild variant="outline"><a href={githubIssueUrl(owner, repo, number)} target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a></Button>
        </>
      } />
    </main>
  )
  if (item === undefined) return <main className="issues-screen"><RepoHeader />{back}<OfflineFallback><p role="status">Syncing issue…</p></OfflineFallback></main>
  const shown = conversationProps(item, rows ?? [], { owner, name: repo })
  const made = todosByIssue(todosRepoId, todoRows, owner, repo).get(number)
  const make = mayMakeTodo(session !== undefined && mayChange(session, confirmed, answer), shown)
  const control = triageControlOf(item, triagePending ?? [], {
    triage: session !== undefined && mayTriage(session, confirmed, answer),
    flowOn: triage !== undefined && !triage.paused,
  })
  return (
    <main className="issues-screen"><RepoHeader />{back}

      <ItemConversation
        {...shown}
        aside={made === undefined && !make ? undefined : (
          <ItemAsideSection title={TODO} {...(made === undefined ? {} : { links: made.links })} onNavigate={(href) => void navigate({ href })}>
            {make
              ? (
                <Button
                  variant="outline"
                  size="sm"
                  aria-keyshortcuts={MAKE_TODO_KEY}
                  onClick={() => void navigate({ href: todos.actions.fromIssue(owner, repo, number) })}
                >
                  {MAKE_TODO} <Kbd aria-hidden="true">{MAKE_TODO_KEY}</Kbd>
                </Button>
              )
              : null}
          </ItemAsideSection>
        )}
        headerActions={!control.shown ? undefined : (
          <>
          {item.triage === "accepted" ? <CommitmentControl value={item.commitment} pending={triagePending?.find((row) => row.number === number && row.op === "issue/commitment")?.pending} onChange={session !== undefined && mayManageTriage(session, confirmed, answer) ? (commitment) => actions.setCommitment(owner, repo, number, commitment, triagePending?.find((row) => row.number === number && row.op === "issue/commitment" && row.pending === "not_sent")?.id) : undefined} /> : null}
          <TriageControl
            state={control.state}
            pending={control.pending}
            disabled={control.disabled}
            onAccept={control.accept ? () => actions.triage(owner, repo, number, "accept") : undefined}
            onReject={control.reject ? () => actions.triage(owner, repo, number, "reject") : undefined}
            onRunAgain={control.runAgain ? () => actions.runTriageAgain(owner, repo, number) : undefined}
          />
          </>
        )}
        comments={shown.comments.map((comment) => ({
          ...comment,
          actions: comment.editable
            ? (
              <>
                <Button variant="outline" size="sm" onClick={() => actions.edit(comment.id)}>{EDIT}</Button>
                <Button variant="ghost" size="sm" onClick={() => actions.discard(comment.id)}>{DISCARD}</Button>
              </>
            )
            : undefined,
        }))}
        composer={session !== undefined && mayWrite(session, confirmed, answer)
          ? {
            draft: draftOf(view).body,
            onDraft: (body) => actions.setCommentDraft(owner, repo, number, body),
            onSubmit: () => void actions.comment(owner, repo, number),
            disabled: view?.submitting === true,
          }
          : undefined}
      />
      {view?.submissionFailed === true ? <p role="alert">Not sent</p> : null}
      {session?.status === "signed_out" ? <SignInButton /> : null}
    </main>
  )
}
