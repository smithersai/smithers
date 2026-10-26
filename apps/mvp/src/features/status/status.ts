import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import { answer, focus, setDraft } from "./actions"
import type { AnswerValue } from "./schema"
import { StatusStore } from "./store"

// Agent status as a frontend sees it (decision 0015): live queries to read and plain functions to act, with no Effect
// in sight. The conversation a tab shows renders each answer's state and question from its own `statuses`; the header
// reads that conversation's `latest`. The tab title follows the store's `waits`. The toast stack and the top bar's bell
// read the feed (decision 0009, src/features/attention/).

type Store = StatusStore["Service"]

/** One conversation's live queries. */
export interface ConversationStatusQueries {
  readonly statuses: Store["statuses"]["tanstack"]
  readonly latest: Store["latest"]["tanstack"]
}

/** What a frontend reads live. */
export interface StatusQueries {
  /**
   * A conversation's statuses and latest answer, by its id, once chat has it open: a branch's, or the home one's for
   * `null` and for a branch chat hasn't opened.
   */
  readonly of: (conversationId: string | null | undefined) => ConversationStatusQueries
}

/** What a person does, as plain functions. Each returns at once. */
export interface StatusActions {
  /** Answers run `id`'s open question: words or an option, or `true` (Approve), `false` (Deny) or `{ approved, note }`. */
  readonly answer: (id: string, value: AnswerValue) => void
  readonly setDraft: (id: string, text: string) => void
  /** Brings run `id`'s question card into view and focuses it: a toast's Answer. */
  readonly focus: (id: string) => void
}

export class Status extends Context.Service<Status, { readonly queries: StatusQueries; readonly actions: StatusActions }>()(
  "@smthrs/mvp/status/Status",
) {
  /** Binds the store's queries and the actions for frontends, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    Status,
    Effect.gen(function* () {
      const store = yield* StatusStore
      const { runSync: run } = runners(yield* Effect.context<StatusStore | FlowDispatch>(), "status")
      const queriesOf = ({ statuses, latest }: { readonly statuses: Store["statuses"]; readonly latest: Store["latest"] }) => ({
        statuses: statuses.tanstack,
        latest: latest.tanstack,
      })
      return Status.of({
        queries: {
          // A branch chat has open: its status is built as chat opens it, before a tab shows it.
          of: (conversationId) =>
            queriesOf((conversationId === null || conversationId === undefined ? undefined : store.opened(conversationId)) ?? store),
        },
        actions: {
          answer: (id, value) => run(answer(id, value)),
          setDraft: (id, text) => run(setDraft(id, text)),
          focus: (id) => run(focus(id)),
        },
      })
    }),
  )
}

/** The status layer's value: what frontends get. */
export type StatusView = Status["Service"]
