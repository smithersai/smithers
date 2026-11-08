import { type Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { Effect } from "effect"
import { anyOf, type Gated, type Source } from "../repo/gate"
import { type Detail, type Entry, type Panel, UNATTRIBUTED_NOTICE_KINDS } from "./schema"

// What frontends read of the feed (decision 0009 §4), each a live query over this tab's collections (store.ts): the
// toasts and the rest of the person's list, on a page and over a conversation; and the notifications panel: its
// entries, the unread count, its state and the expanded entry's detail. Each reads the entries only as `shownQuery`
// gives them (decision 0110, the data gate): none of a repository, or a repository's conversation, that may not show.

/** Where an entry shows as a toast: on a page, or over a conversation. */
type StackField = "stack" | "stackHere"

/** The toasts, most urgent first: needs you, failed, live, done, updates. */
export const stackQuery = (entries: Source<Entry>, field: StackField) =>
  LiveQuery.make((q) =>
    q
      .from({ entry: entries.tanstack })
      .where(({ entry }) => Query.eq(entry[field], true))
      .orderBy(({ entry }) => entry.order)
  )

/** The person's other entries, which `+N` counts: in their list, and not a toast now. */
export const listQuery = (entries: Source<Entry>, field: StackField) =>
  LiveQuery.make((q) =>
    q
      .from({ entry: entries.tanstack })
      .where(({ entry }) => Query.and(Query.eq(entry.listed, true), Query.eq(entry[field], false)))
      .orderBy(({ entry }) => entry.order)
  )

/** A list of entries, as the views read it. */
export type Entries = Effect.Success<ReturnType<typeof stackQuery>>

/** The notifications panel's entries: every one in the person's list, newest first. */
export const feedQuery = (entries: Source<Entry>) =>
  LiveQuery.make((q) =>
    q
      .from({ entry: entries.tanstack })
      .where(({ entry }) => Query.eq(entry.listed, true))
      .orderBy(({ entry }) => entry.atMs, "desc")
  )

/** The person's unread entries: the bell counts them. */
export const unreadQuery = (entries: Source<Entry>) =>
  LiveQuery.make((q) =>
    q
      .from({ entry: entries.tanstack })
      .where(({ entry }) => Query.and(Query.eq(entry.listed, true), Query.eq(entry.unread, true)))
  )

/** The person's own runs waiting on them: the bell's `Needs you`, newest first. */
export const needsQuery = (entries: Source<Entry>) =>
  LiveQuery.make((q) =>
    q
      .from({ entry: entries.tanstack })
      .where(({ entry }) =>
        Query.and(Query.eq(entry.listed, true), Query.and(Query.eq(entry.mine, true), Query.eq(entry.state, "needs_you")))
      )
      .orderBy(({ entry }) => entry.atMs, "desc")
  )

/** The panel's one row. */
export const panelQuery = (panel: Collection.Collection<Panel, string>) =>
  LiveQuery.make((q) => q.from({ panel: panel.tanstack }).findOne())

/** The expanded entry's detail, if one is expanded and its entry shows (`shown`, `shownQuery`). */
export const detailQuery = (details: Collection.Collection<Detail, string>, shown: Source<Entry>) =>
  LiveQuery.make((q) =>
    q
      .from({ detail: details.tanstack })
      .innerJoin({ entry: shown.tanstack }, ({ detail, entry }) => Query.eq(detail.id, entry.id))
      .select(({ detail }) => detail)
      .findOne()
  )

/**
 * The entries that may show (decision 0110, the data gate): one about a repository while that repository may show
 * (`byRepo`, the repository store's gate); one naming no repository but a conversation while that conversation's
 * repository may (`byConversation`, ConversationOwners' `ofShown`); and one naming neither only if its kind is a
 * deployment's own (`UNATTRIBUTED_NOTICE_KINDS`). Each entry is in at most one of the three.
 */
const UNATTRIBUTED = Object.entries(UNATTRIBUTED_NOTICE_KINDS).flatMap(([kind, why]) => why === null ? [] : [kind])

export const shownQuery = (entries: Source<Entry>, byRepo: Source<Entry>, byConversation: Source<Entry>) =>
  LiveQuery.make(
    (q) =>
      q.unionAll(
        q.from({ repository: byRepo.tanstack }).select(({ repository }) => repository),
        q.from({ conversation: byConversation.tanstack }).select(({ conversation }) => conversation),
        q
          .from({ own: entries.tanstack })
          .where(({ own }) => Query.and(
            Query.or(Query.isNull(own.repoId), Query.isUndefined(own.repoId)),
            Query.isNull(own.conversationId),
            anyOf(UNATTRIBUTED.map((kind) => Query.eq(own.kind, kind))),
          ))
          .select(({ own }) => own),
      ) as unknown as LiveQuery.AnyQuery,
    // No `getKey`: an entry that moves between the branches (it gains a repository) is inserted by one before the other
    // deletes it, and one key for both would refuse the insert. TanStack DB's own key tells the branches apart.
  ).pipe(Effect.map((query) => query as unknown as Gated<Entry>))

/** The entries that name no repository but a conversation: what `shownQuery` attributes through the conversation. */
export const ofConversationQuery = (entries: Source<Entry>) =>
  LiveQuery.make(
    (q) =>
      q
        .from({ entry: entries.tanstack })
        .where(({ entry }) =>
          Query.and(Query.or(Query.isNull(entry.repoId), Query.isUndefined(entry.repoId)), Query.not(Query.isNull(entry.conversationId)))
        )
        .select(({ entry }) => entry),
    { getKey: (entry) => entry.id },
  )
