import { type Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import type { Comment, Item, ItemSummary, WriteRow } from "../issues/schema"
import type { CheckRow, FilesRow, PullCommitRow, PullRow, PullsView, ReviewRow } from "./schema"

// What every frontend reads of pull requests (decision 0012 §6). Each is a live query over this device's collections,
// built once per PullsStore, for the repository and pull request the route shows (`view`); it starts on first read. No
// query waits for the network. A pull request's title, body, state and conversation are its `items` and `comments` rows,
// which the issues' store keeps; what only a pull request has is its `pulls` row.

type View = Collection.Collection<PullsView, string>
/** A repository's synced rows, or the empty local rows of a repository nobody opened. */
type Synced<A extends object> = Collection.Collection<A, any, any>

/** The routed repository's pull requests, newest first, with their head, draft and merge state. */
export const listQuery = (view: View, items: Synced<ItemSummary>, pulls: Synced<PullRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ listed: view.tanstack })
      .innerJoin({ item: items.tanstack }, ({ listed, item }) => Query.eq(listed.repoId, item.repoId))
      .leftJoin({ pull: pulls.tanstack }, ({ item, pull }) => Query.eq(item.id, pull.itemId))
      .where(({ item }) => Query.and(Query.eq(item.kind, "pull"), Query.isNull(item.deletedAt)))
      .select(({ item, pull }) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        state: item.state,
        author: Query.coalesce(item.authorLogin, ""),
        comments: item.comments,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        draft: Query.coalesce(pull?.draft, false),
        merged: Query.coalesce(pull?.merged, false),
        headRef: Query.coalesce(pull?.headRef, ""),
      }))
      .orderBy(({ $selected }) => $selected.number, "desc"),
  )

/** The routed pull request: its `items` row and, once synced, its `pulls` row. */
export const pullQuery = (view: View, items: Synced<Item>, pulls: Synced<PullRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .innerJoin({ item: items.tanstack }, ({ view, item }) => Query.eq(view.repoId, item.repoId))
      .leftJoin({ pull: pulls.tanstack }, ({ item, pull }) => Query.eq(item.id, pull.itemId))
      .where(({ view, item }) =>
        Query.and(Query.eq(item.number, view.number), Query.eq(item.kind, "pull"), Query.isNull(item.deletedAt))
      )
      .select(({ item, pull }) => ({
        id: item.id,
        number: item.number,
        title: item.title,
        body: item.body,
        state: item.state,
        author: item.authorLogin,
        createdAt: item.createdAt,
        synced: Query.coalesce(pull?.number, 0),
        headRef: Query.coalesce(pull?.headRef, ""),
        headSha: Query.coalesce(pull?.headSha, ""),
        baseRef: Query.coalesce(pull?.baseRef, ""),
        baseSha: Query.coalesce(pull?.baseSha, ""),
        defaultBranch: Query.coalesce(pull?.defaultBranch, ""),
        draft: Query.coalesce(pull?.draft, false),
        merged: Query.coalesce(pull?.merged, false),
        mergedBy: Query.coalesce(pull?.mergedBy, ""),
        mergeSha: Query.coalesce(pull?.mergeSha, ""),
        mergeableState: Query.coalesce(pull?.mergeableState, ""),
        additions: Query.coalesce(pull?.additions, 0),
        deletions: Query.coalesce(pull?.deletions, 0),
        changedFiles: Query.coalesce(pull?.changedFiles, 0),
        commitCount: Query.coalesce(pull?.commitCount, 0),
      }))
      .findOne()
  )

/** The routed pull request's conversation comments, in GitHub's order. */
export const commentsQuery = (view: View, items: Synced<ItemSummary>, comments: Synced<Comment>) =>
  LiveQuery.make((q) =>
    q
      .from({ page: view.tanstack })
      .innerJoin({ item: items.tanstack }, ({ page, item }) => Query.eq(page.repoId, item.repoId))
      .innerJoin({ comment: comments.tanstack }, ({ item, comment }) => Query.eq(item.id, comment.itemId))
      .where(({ page, item, comment }) => Query.and(Query.eq(item.number, page.number), Query.isNull(comment.deletedAt)))
      .select(({ comment }) => ({
        id: comment.id,
        author: Query.coalesce(comment.authorLogin, ""),
        createdAt: comment.createdAt,
        body: comment.body,
        at: comment.githubId,
      }))
      .orderBy(({ $selected }) => $selected.at),
  )

/** The routed pull request's reviews, oldest first. */
export const reviewsQuery = (view: View, items: Synced<ItemSummary>, reviews: Synced<ReviewRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ page: view.tanstack })
      .innerJoin({ item: items.tanstack }, ({ page, item }) => Query.eq(page.repoId, item.repoId))
      .innerJoin({ review: reviews.tanstack }, ({ item, review }) => Query.eq(item.id, review.itemId))
      .where(({ page, item }) => Query.eq(item.number, page.number))
      .select(({ review }) => ({
        id: review.id,
        author: Query.coalesce(review.authorLogin, ""),
        state: review.state,
        body: review.body,
        commitSha: Query.coalesce(review.commitSha, ""),
        submittedAt: Query.coalesce(review.submittedAt, ""),
        at: review.githubId,
      }))
      .orderBy(({ $selected }) => $selected.at),
  )

/** The routed pull request's commits, in order. */
export const commitsQuery = (view: View, items: Synced<ItemSummary>, commits: Synced<PullCommitRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ page: view.tanstack })
      .innerJoin({ item: items.tanstack }, ({ page, item }) => Query.eq(page.repoId, item.repoId))
      .innerJoin({ commit: commits.tanstack }, ({ item, commit }) => Query.eq(item.id, commit.itemId))
      .where(({ page, item }) => Query.eq(item.number, page.number))
      .select(({ commit }) => ({
        sha: commit.sha,
        headline: commit.headline,
        author: Query.coalesce(commit.authorLogin, ""),
        authoredAt: Query.coalesce(commit.authoredAt, ""),
        position: commit.position,
      }))
      .orderBy(({ $selected }) => $selected.position),
  )

/** The routed pull request's checks: the Smithers runs on its head, oldest first (decision 0012 decision 12). */
export const checksQuery = (view: View, items: Synced<ItemSummary>, pulls: Synced<PullRow>, checks: Synced<CheckRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ page: view.tanstack })
      .innerJoin({ item: items.tanstack }, ({ page, item }) => Query.eq(page.repoId, item.repoId))
      .innerJoin({ pull: pulls.tanstack }, ({ item, pull }) => Query.eq(item.id, pull.itemId))
      .innerJoin({ check: checks.tanstack }, ({ pull, check }) => Query.eq(pull.headSha, check.sha))
      .where(({ page, item, check }) => Query.and(Query.eq(item.number, page.number), Query.eq(check.repoId, page.repoId)))
      .select(({ check }) => ({
        id: check.id,
        flow: check.flow,
        status: check.status,
        createdAt: check.createdAt,
        updatedAt: check.updatedAt,
      }))
      .orderBy(({ $selected }) => $selected.createdAt),
  )

/** Every comparison this tab read: the page picks the one for its pull request's base and head. */
export const filesQuery = (files: Collection.Collection<FilesRow, string>) =>
  LiveQuery.make((q) => q.from({ files: files.tanstack }).select(({ files }) => files))

/** What the route shows, and this person's merge of it, with its write's status once the server has it. */
export const viewQuery = (view: View, writes: Synced<WriteRow>) =>
  LiveQuery.make((q) =>
    q
      .from({ view: view.tanstack })
      .leftJoin({ write: writes.tanstack }, ({ view, write }) => Query.eq(view.mergeWriteId, write.id))
      .select(({ view, write }) => ({
        owner: view.owner,
        name: view.name,
        repoId: view.repoId,
        number: view.number,
        tab: view.tab,
        merging: view.merging,
        mergeWriteId: view.mergeWriteId,
        mergeRefused: view.mergeRefused,
        reviewing: view.reviewing,
        reviewNotice: view.reviewNotice,
        installed: view.installed,
        pullAbsent: view.pullAbsent,
        pullStatus: view.pullStatus,
        mergeStatus: Query.coalesce(write?.status, ""),
        mergeFailure: Query.coalesce(write?.failure, ""),
      }))
      .findOne()
  )
