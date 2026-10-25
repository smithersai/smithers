import { Effect, Metric, Stream } from "effect"
import { IssuesStore } from "../issues/store"
import { open as openIssues, reconnectShapes as reconnectIssueShapes } from "../issues/actions"
import { recordShapeRetry } from "../issues/shapeSync"
import { repoId } from "../repo/contract"
import { PullsClient } from "./api"
import { readComparison } from "./comparison"
import { DEFAULT_MERGE_METHOD, type PullTab, SHA } from "./contract"
import { VIEW } from "./schema"
import { PullsStore } from "./store"

// What a person does on the pull request pages, as Effects that finish synchronously. Opening a page sets what the
// route shows and starts the issues' sync, which holds every pull request's title and conversation; the Files tab reads
// its comparison once; Merge sends the person's merge in their own session (decision 0012 decision 6) and the page
// follows the write's row to Merged, or to why not.

/** Merges a person pressed, by `outcome`: `sent`, or the route's refusal. */
export const mergePresses = Metric.counter("smithers_web_pull_merges", {
  description: "Merge presses on a pull request page, by outcome",
  incremental: true,
})

/** What a pull request route calls on a link's hover or focus: starts the sync without showing a page. */
export const warm = Effect.flatMap(IssuesStore, (store) => store.activate)

/** A person's Try again on an unavailable pull; both its own and the shared issue shapes may need reconnecting. */
export const retry = Effect.gen(function* () {
  const store = yield* PullsStore
  yield* Effect.all([
    reconnectIssueShapes,
    store.pulls.reconnect,
    store.commits.reconnect,
    store.reviews.reconnect,
    store.checks.reconnect,
  ], { discard: true })
  yield* recordShapeRetry("pull")
})

/** What the route calls on a navigation: shows `owner/name`'s pull requests, or, with `number`, that one at `tab`. */
export const open = (owner: string, name: string, number?: number, tab: PullTab = "conversation") =>
  Effect.gen(function* () {
    const store = yield* PullsStore
    yield* store.view.update(VIEW, (row) => {
      const same = row.number === (number ?? null) && row.owner === owner && row.name === name
      row.owner = owner
      row.name = name
      row.repoId = repoId(owner, name)
      row.number = number ?? null
      row.tab = tab
      if (!same) {
        row.merging = false
        row.mergeWriteId = null
        row.mergeRefused = null
      }
    })
    // Sync status is shared with issues and must follow this route's repository too.
    yield* openIssues(owner, name)
    // The Files tab reads its comparison once the device has the pull request's base and head.
    if (number !== undefined && tab === "files") {
      yield* store.pull.rows.pipe(
        Stream.filter((rows) => rows.some((row) => row.number === number && SHA.test(row.headSha))),
        Stream.take(1),
        Stream.runForEach((rows) => {
          const row = rows.find((candidate) => candidate.number === number)!
          return loadFiles(owner, name, row.baseSha, row.headSha)
        }),
        Effect.forkIn(store.scope),
      )
    }
  }).pipe(Effect.orDie)

/** Reads the files `base` and `head` differ by into this tab, once: a comparison of two SHAs never changes. */
export const loadFiles = (owner: string, name: string, base: string, head: string) =>
  Effect.flatMap(PullsStore, (store) => readComparison(store.files, store.scope, owner, name, base, head))

/**
 * Merge on the routed pull request, bound to the head and base this device shows: a new write id, sent at once in the
 * person's session; never queued, since a merge that waited offline would skip what the person saw. A refusal stays on
 * the page.
 */
export const merge = (headSha: string, baseSha: string, number: number) =>
  Effect.gen(function* () {
    const store = yield* PullsStore
    // The view's one row is there from the store's start (store.ts `initialData`).
    const view = (yield* store.view.toArray)[0]!
    if (view.merging) return false
    const writeId = crypto.randomUUID()
    yield* store.view.update(VIEW, (row) => {
      row.merging = true
      row.mergeWriteId = writeId
      row.mergeRefused = null
    })
    yield* (yield* PullsClient).merge(view.owner, view.name, {
      writeId,
      number,
      headSha,
      baseSha,
      method: DEFAULT_MERGE_METHOD,
    }).pipe(
      Effect.tap(() => Metric.update(Metric.withAttributes(mergePresses, { outcome: "sent" }), 1)),
      Effect.catch((error) =>
        Effect.andThen(
          Metric.update(Metric.withAttributes(mergePresses, { outcome: String(error.status ?? "unreachable") }), 1),
          store.view.update(VIEW, (row) => {
            row.mergeRefused = error.status === 403 ? "forbidden" : error.status === 401 ? "sign_in" : "unavailable"
          }),
        )
      ),
      Effect.ensuring(Effect.ignore(store.view.update(VIEW, (row) => void (row.merging = false)))),
      Effect.forkIn(store.scope),
    )
    return true
  }).pipe(Effect.orDie)
