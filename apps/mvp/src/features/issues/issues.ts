import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import {
  setCommitment,
  comment,
  create,
  discard,
  edit,
  enableTriage,
  open,
  pauseTriage,
  retry,
  warm,
  runTriageAgain,
  setCommentDraft,
  setNewBody,
  setNewTitle,
  triage,
} from "./actions"
import type { TriageDecision } from "./contract"
import { IssuesStore, type RepoIssues } from "./store"

// Issues as a frontend sees it: live queries to read and plain functions to act, with no Effect in sight. React renders
// the queries with `useLiveQuery`, and the issue routes' loaders call `open`.

type Store = IssuesStore["Service"]

/**
 * What a frontend reads live, for the routed repository and issue: each the routed repository's (`open` opened it
 * before the page shows), none for a repository nobody opened.
 */
export interface IssuesQueries {
  /** What the route shows, with its draft and whether a press is on its way. */
  readonly view: Store["viewState"]["tanstack"]
  readonly writes: Store["writeRows"]["tanstack"]
  /** The repository's issues, this device's own new ones first. */
  readonly list: RepoIssues["list"]["tanstack"]
  /** The routed issue, once the device has it. */
  readonly item: RepoIssues["item"]["tanstack"]
  /** Its comments, this device's own last. */
  readonly conversation: RepoIssues["conversation"]["tanstack"]
  /** The repository's sync, once a walk was complete: before that its counts are unknown. */
  readonly synced: RepoIssues["synced"]["tanstack"]
  /** The repository's sync when Smithers can't sync it (the App can't act there): its lists send people to GitHub. */
  readonly unsynced: RepoIssues["unsynced"]["tanstack"]
  /** Whether this person may read the repository's issues: refused, a page shows sign in or Not found. */
  readonly access: RepoIssues["accessState"]["tanstack"]
  /** Whether the repository's triage flow is on: none until a Maintainer enabled it. */
  readonly triage: RepoIssues["triage"]["tanstack"]
  /** This device's triage writes on the repository still on their way, or not sent. */
  readonly triagePending: RepoIssues["triagePending"]["tanstack"]
  /** The repositories whose issues this tab opened: a repository's issues view in a conversation reads it to redraw once its own open. */
  readonly opened: Store["openedState"]["tanstack"]
  /** Repository `id`'s issues and pull requests, newest first, once something opened them; none before. */
  readonly newestFirstOf: (id: string) => RepoIssues["newestFirst"]["tanstack"]
  /** Its sync rows whose walk completed. */
  readonly walkedOf: (id: string) => RepoIssues["walked"]["tanstack"]
  /** Whether this person may read its issues, as its items shape answered. */
  readonly accessOf: (id: string) => RepoIssues["accessState"]["tanstack"]
  /** Its sync when Smithers can't sync it: its view sends people to GitHub. */
  readonly unsyncedOf: (id: string) => RepoIssues["unsynced"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once. */
export interface IssuesActions {
  readonly setCommitment: (owner: string, name: string, number: number, commitment: import("./lifecycle").Commitment, previousWriteId?: string) => void
  /** What an issue route calls on a navigation: resolves once the repository's issues are open. */
  readonly open: (owner: string, name: string, number?: number) => Promise<void>
  /** What an issue route calls on a link's hover or focus: starts the repository's issues' sync without showing a page. */
  readonly warm: (owner: string, name: string, number?: number) => Promise<void>
  /** Reconnect failed issue shapes now. */
  readonly retry: () => void
  readonly setNewTitle: (owner: string, name: string, title: string) => void
  readonly setNewBody: (owner: string, name: string, body: string) => void
  readonly setCommentDraft: (owner: string, name: string, number: number, body: string) => void
  /** Create issue: whether it ran. */
  readonly create: (owner: string, name: string) => boolean
  /** Comment: whether it ran. */
  readonly comment: (owner: string, name: string, number: number) => boolean
  /** Discard on a write that wasn't sent. */
  readonly discard: (writeId: string) => void
  /** Edit on a write that wasn't sent: the path where its text is back in a draft. */
  readonly edit: (writeId: string) => string | undefined
  /** Accept or Not accepted on an issue. */
  readonly triage: (owner: string, name: string, number: number, decision: TriageDecision) => void
  /** Run triage again on an issue. */
  readonly runTriageAgain: (owner: string, name: string, number: number) => void
  /** Enable or Pause the repository's triage flow. */
  readonly enableTriage: (owner: string, name: string) => void
  readonly pauseTriage: (owner: string, name: string) => void
}

export class Issues extends Context.Service<Issues, { readonly queries: IssuesQueries; readonly actions: IssuesActions }>()(
  "@smthrs/mvp/issues/Issues",
) {
  /** Binds the store's queries and the actions for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Issues,
    Effect.gen(function* () {
      const store = yield* IssuesStore
      const { runSync: run, runPromise: promise } = runners(yield* Effect.context<IssuesStore | FlowDispatch>(), "issues")
      return Issues.of({
        // The routed repository's, read when the page renders.
        queries: {
          view: store.viewState.tanstack,
          writes: store.writeRows.tanstack,
          get list() { return store.routed().list.tanstack },
          get item() { return store.routed().item.tanstack },
          get conversation() { return store.routed().conversation.tanstack },
          get synced() { return store.routed().synced.tanstack },
          get unsynced() { return store.routed().unsynced.tanstack },
          get access() { return store.routed().accessState.tanstack },
          get triage() { return store.routed().triage.tanstack },
          get triagePending() { return store.routed().triagePending.tanstack },
          opened: store.openedState.tanstack,
          newestFirstOf: (id) => (store.opened(id) ?? store.empty).newestFirst.tanstack,
          walkedOf: (id) => (store.opened(id) ?? store.empty).walked.tanstack,
          accessOf: (id) => (store.opened(id) ?? store.empty).accessState.tanstack,
          unsyncedOf: (id) => (store.opened(id) ?? store.empty).unsynced.tanstack,
        },
        actions: {
          setCommitment: (owner, name, number, commitment, previousWriteId) => run(setCommitment(owner, name, number, commitment, previousWriteId)),
          open: (owner, name, number) => promise(open(owner, name, number)),
          warm: (owner, name, number) => promise(warm(owner, name, number)),
          retry: () => run(retry),
          setNewTitle: (owner, name, title) => run(setNewTitle(owner, name, title)),
          setNewBody: (owner, name, body) => run(setNewBody(owner, name, body)),
          setCommentDraft: (owner, name, number, body) => run(setCommentDraft(owner, name, number, body)),
          create: (owner, name) => run(create(owner, name)),
          comment: (owner, name, number) => run(comment(owner, name, number)),
          discard: (writeId) => run(discard(writeId)),
          edit: (writeId) => run(edit(writeId)),
          triage: (owner, name, number, decision) => run(triage(owner, name, number, decision)),
          runTriageAgain: (owner, name, number) => run(runTriageAgain(owner, name, number)),
          enableTriage: (owner, name) => run(enableTriage(owner, name)),
          pauseTriage: (owner, name) => run(pauseTriage(owner, name)),
        },
      })
    }),
  )
}

/** The issues layer's value: what frontends get. */
export type IssuesLayer = Issues["Service"]
