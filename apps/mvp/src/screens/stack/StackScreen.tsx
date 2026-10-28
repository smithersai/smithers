import { NotSentChanges } from "../../features/todos/components/NotSentChanges"
import { RepoHeader } from "../../features/repo/components/RepoHeader"
import { HomeTabs } from "../../features/home/components/HomeTabs"
import { Breadcrumbs, Button, EmptyState, IssuesView } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate, useParams, useSearch } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { DraftCard } from "../../features/todos/components/DraftCard"
import { useTodos } from "../../features/todos/components/TodosContext"
import {
  NEW_TODO,
  NO_TODOS,
  STACK,
  stackFilterOf,
  stackPath,
  todoPath,
} from "../../features/todos/contract"
import {
  accessFor,
  draftsOfRepo,
  mayChange,
  stackItemsOf,
  stackRows,
  withDrop,
} from "../../features/todos/view"
import "./stack-screen.css"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"

// /$owner/$repo/stack (decision 0016 §4), drawn as GitHub's issue list: Open (the stack in merge order, then this
// device's commits the stack hasn't numbered) and Closed (merged and dropped, latest first) tabs with counts, each row
// with its state icon, title, T<n>, who and when, its branch and pull request, and Drop in its menu; this device's
// drafts above, and its changes that weren't sent below, with Edit and Discard. New TODO and Drop show for a Member or
// above. The page's frame paints at once; until the device restored or synced the stack, its list is empty with no
// counts, never the empty state and never a loading state. A stack this person may not read shows sign-in, or Not
// found. The route's loader opens the stack (`open`); this screen only renders what the device has.
export function StackScreen() {
  const { owner, repo } = useParams({ from: "/$owner/$repo/stack" })
  const search = useSearch({ from: "/$owner/$repo/stack" })
  const { queries, actions } = useTodos()
  const auth = useAuth()
  const { data: view } = useLiveQuery(queries.view)
  const repoId = view?.repoId ?? ""
  const stack = queries.stack(repoId)
  const { data: todos } = useLiveQuery(stack.todos)
  const { data: sending } = useLiveQuery(queries.sending)
  const { data: requested } = useLiveQuery(queries.requested)
  const { data: drafts } = useLiveQuery(queries.drafts)
  const { data: access } = useLiveQuery(queries.access)
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const answer = useRepoAnswer(owner, repo)
  const navigate = useNavigate()
  const status = accessFor(repoId, access)
  if (status === "sign_in") return <main className="stack-screen" aria-label="Stack"><RepoHeader /><HomeTabs /><EmptyState title="Members can make TODOs." /><SignInButton /></main>
  if (status === "forbidden") {
    return <main className="stack-screen" aria-label="Stack"><RepoHeader /><HomeTabs /><EmptyState title="Members can make TODOs." /></main>
  }
  const rows = stackRows(repoId, todos, sending, requested)
  const may = status === "allowed" && session !== undefined && mayChange(session, confirmed, answer)
  return (
    <main className="stack-screen" aria-label="Stack"><RepoHeader /><HomeTabs />
      <Breadcrumbs
        items={[{ key: "repo", label: `${owner}/${repo}`, href: `/${owner}/${repo}` }, { key: "stack", label: STACK }]}
        onNavigate={(item) => void navigate({ href: item.href! })}
      />
      {draftsOfRepo(repoId, drafts).map((draft) => <DraftCard key={draft.id} draft={draft} />)}
      <IssuesView
        repo={`${owner}/${repo}`}
        aria-label={`${owner}/${repo} stack`}
        size="full"
        ordered
        numberPrefix="T"
        emptyTitle={NO_TODOS}
        unknown={status === "unknown" && rows.length === 0}
        issues={withDrop(stackItemsOf(rows, todos, owner, repo), may, (number) => actions.drop(owner, repo, number))}
        filter={{
          state: stackFilterOf(search.state),
          href: (state) => stackPath(owner, repo, state),
          onSelect: (_, href) => void navigate({ href }),
        }}
        href={(todo) => (todo.number === null ? undefined : todoPath(owner, repo, todo.number))}
        onNavigate={(_, href) => void navigate({ href })}
        actions={may ? <Button onClick={() => actions.newDraft(owner, repo)}>{NEW_TODO}</Button> : undefined}
      />
      <NotSentChanges repoId={repoId} />
    </main>
  )
}
