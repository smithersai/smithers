import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import { retryChange, retry, commit, discard, discardDraft, drop, edit, fromIssue, newDraft, open, setPrompt, setTitle, warm } from "./actions"
import { type RepoStack, TodosStore } from "./store"

// TODOs as a frontend sees it: live queries to read and plain functions to act, with no Effect in sight. React renders
// the queries with `useLiveQuery`, and the stack routes' loaders call `open`.

type Store = TodosStore["Service"]

/** A repository's stack, live: its TODOs and their prompts. */
export interface StackQueries {
  readonly todos: RepoStack["todos"]["tanstack"]
  readonly requests: RepoStack["requests"]["tanstack"]
}

/** What a frontend reads live. */
export interface TodosQueries {
  /** What the route shows: the repository, the TODO it names, and the draft whose Commit is on its way. */
  readonly view: Store["viewQuery"]["tanstack"]
  /** This device's private drafts, every repository's. */
  readonly drafts: Store["draftsQuery"]["tanstack"]
  /** This device's changes in the outbox, and those the route took or refused. */
  readonly sending: Store["sendingQuery"]["tanstack"]
  readonly requested: Store["requestedQuery"]["tanstack"]
  /** Whether this person may read each opened stack, as its shape last said. */
  readonly access: Store["accessQuery"]["tanstack"]
  /** Repository `repoId`'s stack once a route opened it; no rows before. */
  readonly stack: (repoId: string) => StackQueries
}

/** What a person does, as plain functions. Writes resolve after local admission. */
export interface TodosActions {
  /** What a stack route calls on a navigation: resolves once the stack is open, so its queries have its rows. */
  readonly open: (owner: string, name: string, number?: number) => Promise<void>
  /** What a stack route calls on a link's hover or focus: starts syncing the stack without showing it. */
  readonly warm: (owner: string, name: string) => Promise<void>
  /** New TODO: an empty draft; answers its id. */
  readonly newDraft: (owner: string, name: string) => string
  readonly setTitle: (draftId: string, title: string) => void
  readonly setPrompt: (draftId: string, prompt: string) => void
  /** Commit on a draft: the stack's page to show, or nothing when it didn't run. */
  readonly commit: (draftId: string) => Promise<string | undefined>
  readonly discardDraft: (draftId: string) => void
  readonly retry: (owner: string, name: string, number: number) => Promise<void>
  readonly drop: (owner: string, name: string, number: number) => Promise<void>
  /** Make TODO on an issue: drafts a TODO from it; answers the stack's page, where the draft shows. */
  readonly fromIssue: (owner: string, name: string, number: number) => string
  /** Edit on a commit that wasn't sent: the stack's page, where its draft is. */
  readonly edit: (opId: string) => string | undefined
  /** Discard on a change that wasn't sent. */
  readonly discard: (opId: string) => void
  readonly retryChange: (opId: string) => Promise<void>
}

export class Todos extends Context.Service<Todos, { readonly queries: TodosQueries; readonly actions: TodosActions }>()(
  "@smthrs/mvp/todos/Todos",
) {
  /** Binds the store's queries and the actions for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Todos,
    Effect.gen(function* () {
      const store = yield* TodosStore
      const context = yield* Effect.context<TodosStore | FlowDispatch>()
      const { runSync: run, runPromise: runAsync } = runners(context, "todos")
      const stackQueries = (stack: RepoStack): StackQueries => ({
        todos: stack.todos.tanstack,
        requests: stack.requests.tanstack,
      })
      return Todos.of({
        queries: {
          view: store.viewQuery.tanstack,
          drafts: store.draftsQuery.tanstack,
          sending: store.sendingQuery.tanstack,
          requested: store.requestedQuery.tanstack,
          access: store.accessQuery.tanstack,
          stack: (repoId) => stackQueries(store.opened(repoId) ?? store.empty),
        },
        actions: {
          retryChange: (id) => runAsync(retryChange(id)),
          open: (owner, name, number) => runAsync(open(owner, name, number)),
          warm: (owner, name) => runAsync(warm(owner, name)),
          newDraft: (owner, name) => run(newDraft(owner, name)),
          setTitle: (draftId, title) => run(setTitle(draftId, title)),
          setPrompt: (draftId, prompt) => run(setPrompt(draftId, prompt)),
          commit: (draftId) => runAsync(commit(draftId)),
          discardDraft: (draftId) => run(discardDraft(draftId)),
          retry: (owner, name, number) => runAsync(retry(owner, name, number)),
          drop: (owner, name, number) => runAsync(drop(owner, name, number)),
          fromIssue: (owner, name, number) => run(fromIssue(owner, name, number)),
          edit: (opId) => run(edit(opId)),
          discard: (opId) => run(discard(opId)),
        },
      })
    }),
  )
}

/** The TODOs layer's value: what frontends get. */
export type TodosView = Todos["Service"]
