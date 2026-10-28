import { NotSentChanges } from "../../features/todos/components/NotSentChanges"
import { Button, Breadcrumbs, ConfirmButton, EmptyState, ItemAsideSection, ItemConversation, ItemStateIcon } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import { useNavigate, useParams } from "@tanstack/react-router"
import { useAuth } from "../../features/auth/components/AuthContext"
import { SignInButton } from "../../features/auth/components/SignInButton"
import { useTodos } from "../../features/todos/components/TodosContext"
import { BRANCH, DROP, ISSUE, NOT_FOUND, PULL_REQUEST, RUN, STACK, stackPath } from "../../features/todos/contract"
import { mayRetry, accessFor, dropConfirm, mayChange, stackRows, todoCardOf, todoScreenOf } from "../../features/todos/view"
import "./stack-screen.css"
import { useRepoAnswer } from "../../features/repo/components/RepoContext"

// /$owner/$repo/stack/$number (decision 0016 §4): one TODO as GitHub's issue page. Its title and T<n>, its state pill,
// whose icon blinks while it is Working; who committed it and when; its prompt and acceptance criteria; a timeline of
// what happened to it; and a side column with the issue it was made from, its branch and pull request when it has
// them, its run while it runs (Watch, ruling TODO-3), and Drop for a Member or above while it is on the stack. Until
// the device has the TODO, the page's frame only; once the stack answered without it, Not found. A stack this person
// may not read shows sign-in, or Not found.
export function TodoScreen() {
  const { owner, repo, number } = useParams({ from: "/$owner/$repo/stack/$number" })
  const { queries, actions } = useTodos()
  const auth = useAuth()
  const { data: view } = useLiveQuery(queries.view)
  const repoId = view?.repoId ?? ""
  const stack = queries.stack(repoId)
  const { data: todos } = useLiveQuery(stack.todos)
  const { data: requests } = useLiveQuery(stack.requests)
  const { data: sending } = useLiveQuery(queries.sending)
  const { data: requested } = useLiveQuery(queries.requested)
  const { data: access } = useLiveQuery(queries.access)
  const { data: session } = useLiveQuery(auth.queries.session)
  const { data: confirmed } = useLiveQuery(auth.queries.confirmed)
  const answer = useRepoAnswer(owner, repo)
  const navigate = useNavigate()
  const status = accessFor(repoId, access)
  if (status === "sign_in") return <main className="stack-screen" aria-label="TODO"><SignInButton /></main>
  const card = todoCardOf(number, stackRows(repoId, todos, sending, requested), todos, requests)
  const screen = status === "forbidden" ? { kind: "missing" as const } : todoScreenOf(card, number, todos, status, owner, repo)
  const todo = todos.find((todo) => todo.number === number)
  const retryable = todo !== undefined && session !== undefined && mayRetry(todo, session, answer)
  const may = session !== undefined && mayChange(session, confirmed, answer)
  return (
    <main className="stack-screen" aria-label="TODO">
      <Breadcrumbs
        items={[
          { key: "repo", label: `${owner}/${repo}`, href: `/${owner}/${repo}` },
          { key: "stack", label: STACK, href: stackPath(owner, repo) },
          { key: "todo", label: `T${number}` },
        ]}
        onNavigate={(item) => void navigate({ href: item.href! })}
      />
      {screen.kind === "waiting" ? <p role="status">Syncing TODO…</p> : null}
      {screen.kind === "missing" ? <EmptyState title={NOT_FOUND} /> : null}
      {screen.kind === "page" ? (
        <ItemConversation
          title={screen.page.title}
          number={screen.page.number}
          numberPrefix="T"
          state={screen.page.state}
          status={screen.page.status}
          author={screen.page.author}
          createdAt={screen.page.createdAt}
          body={screen.page.body}
          events={screen.page.events}
          comments={[]}
          {...(screen.page.pending === undefined ? {} : { pending: screen.page.pending })}
          aside={screen.page.issue === undefined && screen.page.branch === undefined &&
              screen.page.pullRequest === undefined && screen.page.run === undefined && !(may && screen.page.droppable) && !retryable
            ? undefined
            : (
              <>
                {screen.page.issue === undefined ? null : (
                  <ItemAsideSection title={ISSUE} links={[screen.page.issue]} onNavigate={(href) => void navigate({ href })} />
                )}
                {screen.page.branch === undefined ? null : (
                  <ItemAsideSection title={BRANCH} links={[screen.page.branch]} onNavigate={(href) => void navigate({ href })} />
                )}
                {screen.page.pullRequest === undefined ? null : (
                  <ItemAsideSection title={PULL_REQUEST} links={[screen.page.pullRequest]} onNavigate={(href) => void navigate({ href })} />
                )}
                {screen.page.run === undefined ? null : (
                  <ItemAsideSection title={RUN} links={[screen.page.run]} onNavigate={(href) => void navigate({ href })} />
                )}
                {retryable ? <Button size="sm" onClick={() => actions.retry(owner, repo, number)}>Retry</Button> : null}
                {may && screen.page.droppable ? (
                  <ConfirmButton
                    variant="ghost"
                    size="sm"
                    destructive
                    confirm={dropConfirm(number, screen.page.title)}
                    onConfirm={() => actions.drop(owner, repo, number)}
                  >
                    <ItemStateIcon kind="dropped" label={DROP} aria-hidden />
                    {DROP}
                  </ConfirmButton>
                ) : null}
              </>
            )}
        />
      ) : null}
      <NotSentChanges repoId={repoId} number={number} />
    </main>
  )
}
