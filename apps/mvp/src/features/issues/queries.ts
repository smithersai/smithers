import type { ElectricCollection } from "@smthrs/effect-electric"
import { type Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { ISSUES_STREAM } from "./contract"
import type {
  Access,
  Comment,
  Draft,
  IssueView,
  Item,
  Requested,
  Sending,
  SyncRow,
  TriageSettings,
  WriteRow,
} from "./schema"

// What every frontend reads of issues (decision 0012 §6). Each is a live query over this device's collections, built
// once per IssuesStore, for the repository and issue the route shows (`view`); it starts on first read. No query waits
// for the network.
//
// A write this device made shows until GitHub's row with its write id arrives: `items ∪ (requested − items) ∪
// (sending − requested − items)` for issues, and the same over `comments` for an issue's conversation. A synced row
// has `local` 0; this device's own rows have `local` 1, number 0 until GitHub numbers them, and `pending`: `requested`,
// or `not_sent` once the route refused it or the server's write (`writes`) settled refused or failed, with `reason`.

type View = Collection.Collection<IssueView, string>
type Synced<A extends object> = ElectricCollection.ElectricCollection<A>
type Local<A extends object> = Collection.Collection<A, string>

/** A requested write's state: Not sent when the route refused it, or the server's write settled refused or failed. */
const pendingOf = (mine: { readonly status: unknown }, write: { readonly status: unknown } | undefined) =>
  Query.caseWhen(
    Query.or(Query.eq(mine.status, "not_sent"), Query.eq(write?.status, "refused"), Query.eq(write?.status, "failed")),
    "not_sent",
    "requested",
  )

/**
 * The routed repository's issues: GitHub's, newest first, after this device's own new issues, newest first. Each
 * branch of a union names its sources apart, as TanStack DB requires.
 */
export const listQuery = (
  view: View,
  items: Synced<Item>,
  requested: Local<Requested>,
  sending: Local<Sending>,
  writes: Synced<WriteRow>,
) =>
  LiveQuery.make((q) =>
    q
      .unionAll(
        q
          .from({ listed: view.tanstack })
          .innerJoin({ item: items.tanstack }, ({ listed, item }) => Query.eq(listed.repoId, item.repoId))
          .where(({ item }) => Query.and(Query.eq(item.kind, "issue"), Query.isNull(item.deletedAt)))
          .select(({ item }) => ({
            id: item.id,
            number: item.number,
            title: item.title,
            state: item.state,
            author: Query.coalesce(item.authorLogin, ""),
            comments: item.comments,
            updatedAt: item.updatedAt,
            triage: item.triage,
            commitment: Query.coalesce(item.commitment, ""),
            pending: "",
            reason: "",
            local: 0,
            at: item.number,
          })),
        q
          .from({ routed: view.tanstack })
          .innerJoin({ mine: requested.tanstack }, ({ routed, mine }) => Query.eq(routed.repoId, mine.repoId))
          .leftJoin({ opened: items.tanstack }, ({ mine, opened }) => Query.eq(mine.id, opened.writeId))
          .leftJoin({ write: writes.tanstack }, ({ mine, write }) => Query.eq(mine.id, write.id))
          .where(({ mine, opened }) => Query.and(Query.eq(mine.op, "issue/create"), Query.isUndefined(opened?.id)))
          .select(({ mine, write }) => ({
            id: mine.id,
            number: 0,
            title: mine.title,
            state: "open",
            author: "",
            comments: 0,
            updatedAt: "",
            triage: "",
            commitment: "",
            pending: pendingOf(mine, write),
            reason: Query.coalesce(mine.reason, write?.failure, ""),
            local: 1,
            at: mine.queuedAt,
          })),
        q
          .from({ shown: view.tanstack })
          .innerJoin({ out: sending.tanstack }, ({ shown, out }) => Query.eq(shown.repoId, out.repoId))
          .leftJoin({ kept: requested.tanstack }, ({ out, kept }) => Query.eq(out.id, kept.id))
          .leftJoin({ arrived: items.tanstack }, ({ out, arrived }) => Query.eq(out.id, arrived.writeId))
          .where(({ out, kept, arrived }) =>
            Query.and(Query.eq(out.op, "issue/create"), Query.isUndefined(kept?.id), Query.isUndefined(arrived?.id))
          )
          .select(({ out }) => ({
            id: out.id,
            number: 0,
            title: out.title,
            state: "open",
            author: "",
            comments: 0,
            updatedAt: "",
            triage: "",
            commitment: "",
            pending: "requested",
            reason: "",
            local: 1,
            at: out.queuedAt,
          })),
      )
      .orderBy(({ $selected }) => $selected.local, "desc")
      .orderBy(({ $selected }) => $selected.at, "desc"),
  )

/**
 * Every repository's synced issues this device has, newest first, as list rows (`repoId` beside each): what a
 * repository's issues view in a conversation lists, filtered to its repository (view.ts `embeddedIssues`). Synced rows
 * only: a person's own new issue shows on the repository's issues page.
 */
export const allIssuesQuery = (items: Synced<Item>) =>
  LiveQuery.make((q) =>
    q
      .from({ item: items.tanstack })
      .where(({ item }) => Query.and(Query.eq(item.kind, "issue"), Query.isNull(item.deletedAt)))
      .select(({ item }) => ({
        id: item.id,
        repoId: item.repoId,
        number: item.number,
        title: item.title,
        state: item.state,
        author: Query.coalesce(item.authorLogin, ""),
        comments: item.comments,
        updatedAt: item.updatedAt,
        triage: item.triage,
        commitment: Query.coalesce(item.commitment, ""),
        pending: "",
        reason: "",
        local: 0,
      }))
      .orderBy(({ $selected }) => $selected.number, "desc"),
  )

/** Every repository whose issues sync completed a walk: before that, its counts are unknown. */
export const syncedRepositoriesQuery = (sync: Synced<SyncRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ sync: sync.tanstack })
      .where(({ sync }) => Query.and(Query.eq(sync.stream, ISSUES_STREAM), Query.eq(sync.complete, true)))
      .select(({ sync }) => ({ repoId: sync.repoId, syncedAt: sync.syncedAt }))
  )

/** The routed issue, once the device has it. */
export const itemQuery = (view: View, items: Synced<Item>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .innerJoin({ item: items.tanstack }, ({ view, item }) => Query.eq(view.repoId, item.repoId))
      .where(({ view, item }) =>
        Query.and(Query.eq(item.number, view.number), Query.eq(item.kind, "issue"), Query.isNull(item.deletedAt))
      )
      .select(({ item }) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        body: item.body,
        state: item.state,
        author: item.authorLogin,
        createdAt: item.createdAt,
        triage: item.triage,
        pinned: item.triagePinned,
        commitment: item.commitment,
      }))
      .findOne()
  )

/** The routed issue's comments: GitHub's in its order, then this device's own, in the order made. */
export const conversationQuery = (
  view: View,
  items: Synced<Item>,
  comments: Synced<Comment>,
  requested: Local<Requested>,
  sending: Local<Sending>,
  writes: Synced<WriteRow>,
) =>
  LiveQuery.make((q) =>
    q
      .unionAll(
        q
          .from({ page: view.tanstack })
          .innerJoin({ issue: items.tanstack }, ({ page, issue }) => Query.eq(page.repoId, issue.repoId))
          .innerJoin({ comment: comments.tanstack }, ({ issue, comment }) => Query.eq(issue.id, comment.itemId))
          .where(({ page, issue, comment }) =>
            Query.and(Query.eq(issue.number, page.number), Query.isNull(comment.deletedAt))
          )
          .select(({ comment }) => ({
            id: comment.id,
            author: Query.coalesce(comment.authorLogin, ""),
            createdAt: comment.createdAt,
            body: comment.body,
            pending: "",
            reason: "",
            local: 0,
            at: comment.githubId,
          })),
        q
          .from({ routed: view.tanstack })
          .innerJoin({ mine: requested.tanstack }, ({ routed, mine }) => Query.eq(routed.repoId, mine.repoId))
          .leftJoin({ posted: comments.tanstack }, ({ mine, posted }) => Query.eq(mine.id, posted.writeId))
          .leftJoin({ write: writes.tanstack }, ({ mine, write }) => Query.eq(mine.id, write.id))
          .where(({ routed, mine, posted }) =>
            Query.and(
              Query.eq(mine.op, "issue/comment"),
              Query.eq(mine.number, routed.number),
              Query.isUndefined(posted?.id),
            )
          )
          .select(({ mine, write }) => ({
            id: mine.id,
            author: "",
            createdAt: "",
            body: mine.body,
            pending: pendingOf(mine, write),
            reason: Query.coalesce(mine.reason, write?.failure, ""),
            local: 1,
            at: mine.queuedAt,
          })),
        q
          .from({ shown: view.tanstack })
          .innerJoin({ out: sending.tanstack }, ({ shown, out }) => Query.eq(shown.repoId, out.repoId))
          .leftJoin({ kept: requested.tanstack }, ({ out, kept }) => Query.eq(out.id, kept.id))
          .leftJoin({ arrived: comments.tanstack }, ({ out, arrived }) => Query.eq(out.id, arrived.writeId))
          .where(({ shown, out, kept, arrived }) =>
            Query.and(
              Query.eq(out.op, "issue/comment"),
              Query.eq(out.number, shown.number),
              Query.isUndefined(kept?.id),
              Query.isUndefined(arrived?.id),
            )
          )
          .select(({ out }) => ({
            id: out.id,
            author: "",
            createdAt: "",
            body: out.body,
            pending: "requested",
            reason: "",
            local: 1,
            at: out.queuedAt,
          })),
      )
      .orderBy(({ $selected }) => $selected.local)
      .orderBy(({ $selected }) => $selected.at),
  )

/** The routed repository's issues sync, once a walk of it was complete: before that, its counts are unknown. */
export const syncedQuery = (view: View, sync: Synced<SyncRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .innerJoin({ sync: sync.tanstack }, ({ view, sync }) => Query.eq(view.repoId, sync.repoId))
      .where(({ sync }) => Query.and(Query.eq(sync.stream, ISSUES_STREAM), Query.eq(sync.complete, true)))
      .select(({ sync }) => ({ syncedAt: sync.syncedAt }))
      .findOne()
  )

/** What the route shows, with the draft its form or composer edits, if any, and whether a press is on its way. */
export const viewQuery = (view: View, drafts: Local<Draft>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ draft: drafts.tanstack }, ({ view, draft }) => Query.eq(view.draftKey, draft.id))
      .select(({ view, draft }) => ({
        owner: view.owner,
        name: view.name,
        number: view.number,
        submitting: view.submitting,
        title: draft?.title,
        body: draft?.body,
      }))
      .findOne()
  )

/** Whether `write`'s operation is one of triage's, which carry no GitHub row of their own. */
const isTriage = (write: { readonly op: unknown }) =>
  Query.or(
    Query.eq(write.op, "issue/triage"),
    Query.eq(write.op, "issue/commitment"),
    Query.eq(write.op, "triage/run"),
    Query.eq(write.op, "triage/enable"),
    Query.eq(write.op, "triage/pause"),
  )

/**
 * This device's requested writes whose GitHub row arrived, or, for triage's writes, which carry no row of their own,
 * whose server write is done (the issue's row says the rest): the follower drops them.
 */
export const deliveredQuery = (
  requested: Local<Requested>,
  items: Synced<Item>,
  comments: Synced<Comment>,
  writes: Synced<WriteRow>,
) =>
  LiveQuery.make((q) =>
    q.unionAll(
      q
        .from({ mine: requested.tanstack })
        .innerJoin({ item: items.tanstack }, ({ mine, item }) => Query.eq(mine.id, item.writeId))
        .select(({ mine }) => ({ id: mine.id })),
      q
        .from({ ours: requested.tanstack })
        .innerJoin({ comment: comments.tanstack }, ({ ours, comment }) => Query.eq(ours.id, comment.writeId))
        .select(({ ours }) => ({ id: ours.id })),
      q
        .from({ triaged: requested.tanstack })
        .innerJoin({ done: writes.tanstack }, ({ triaged, done }) => Query.eq(triaged.id, done.id))
        .where(({ triaged, done }) => Query.and(isTriage(triaged), Query.eq(done.status, "done")))
        .select(({ triaged }) => ({ id: triaged.id })),
    )
  )

/** The routed repository's triage settings: whether its triage flow is on, once a Maintainer enabled it. */
export const triageSettingsQuery = (view: View, settings: Synced<TriageSettings>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .innerJoin({ settings: settings.tanstack }, ({ view, settings }) => Query.eq(view.repoId, settings.repoId))
      .select(({ settings }) => ({ paused: settings.paused, pausedReason: settings.pausedReason }))
      .findOne()
  )

/**
 * This device's triage writes on the routed repository still on their way (`requested`) or refused (`not_sent`): the
 * issue's Accept, Not accepted and Run triage again (`number`), and Enable and Pause (number 0). Newest first.
 */
export const triagePendingQuery = (
  view: View,
  requested: Local<Requested>,
  sending: Local<Sending>,
  writes: Synced<WriteRow>,
) =>
  LiveQuery.make((q) =>
    q
      .unionAll(
        q
          .from({ routed: view.tanstack })
          .innerJoin({ mine: requested.tanstack }, ({ routed, mine }) => Query.eq(routed.repoId, mine.repoId))
          .leftJoin({ write: writes.tanstack }, ({ mine, write }) => Query.eq(mine.id, write.id))
          .where(({ mine }) => isTriage(mine))
          .select(({ mine, write }) => ({
            id: mine.id,
            op: mine.op,
            number: mine.number,
            pending: pendingOf(mine, write),
            at: mine.queuedAt,
          })),
        q
          .from({ shown: view.tanstack })
          .innerJoin({ out: sending.tanstack }, ({ shown, out }) => Query.eq(shown.repoId, out.repoId))
          .leftJoin({ kept: requested.tanstack }, ({ out, kept }) => Query.eq(out.id, kept.id))
          .where(({ out, kept }) => Query.and(isTriage(out), Query.isUndefined(kept?.id)))
          .select(({ out }) => ({
            id: out.id,
            op: out.op,
            number: out.number,
            pending: "requested",
            at: out.queuedAt,
          })),
      )
      .orderBy(({ $selected }) => $selected.at, "desc")
  )

/** Whether this person may read the repository's issues, as the shape last answered. */
export const accessQuery = (access: Local<Access>) =>
  LiveQuery.make((q) => q.from({ access: access.tanstack }).select(({ access }) => ({ status: access.status, installed: access.installed })).findOne())
