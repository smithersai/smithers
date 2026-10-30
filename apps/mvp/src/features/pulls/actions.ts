import { Effect, Metric, Stream } from "effect"
import { codeOf } from "../../errorCode"
import { FlowDispatch } from "../../flows/dispatch"
import { open as openIssues, reconnectShapes as reconnectIssueShapes } from "../issues/actions"
import { recordShapeRetry } from "../issues/shapeSync"
import { repoId } from "../repo/contract"
import { PullsClient } from "./api"
import { readComparison } from "./comparison"
import { DEFAULT_MERGE_METHOD, type PullTab, SHA } from "./contract"
import { VIEW } from "./schema"
import { PullsStore } from "./store"
import { reviewAnswered } from "./view"

// What a person does on the pull request pages, as Effects that finish synchronously. Opening a page sets what the
// route shows and starts the issues' sync, which holds every pull request's title and conversation; the Files tab reads
// its comparison once; Merge sends the person's merge in their own session (decision 0012 decision 6) and the page
// follows the write's row to Merged, or to why not.

/** Merges a person pressed, by `outcome`: `sent`, or the route's refusal. */
export const mergePresses = Metric.counter("smithers_web_pull_merges", {
  description: "Merge presses on a pull request page, by outcome",
  incremental: true,
})

/** What a pull request route calls on a link's hover or focus: starts `owner/name`'s sync without showing a page. */
export const warm = (owner: string, name: string, number?: number) =>
  Effect.flatMap(PullsStore, (store) => Effect.asVoid(store.forRepo(repoId(owner, name), number)))

/** A person's Try again on an unavailable pull; both its own and the repository's issue shapes may need reconnecting. */
export const retry = Effect.gen(function* () {
  const store = yield* PullsStore
  yield* Effect.all([reconnectIssueShapes, store.routed().reconnect], { discard: true })
  yield* recordShapeRetry("pull")
})

/**
 * What the route calls on a navigation: shows `owner/name`'s pull requests, or, with `number`, that one at `tab`; and
 * opens that repository's pull requests and issues, their own shapes (decision 0079 slice 1b), once.
 */
export const open = (owner: string, name: string, number?: number, tab: PullTab = "conversation") =>
  Effect.gen(function* () {
    const store = yield* PullsStore
    yield* store.forRepo(repoId(owner, name), number)
    const previous = (yield* store.view.toArray)[0]!
    const alreadyFollowing = previous.owner === owner && previous.name === name && previous.number === number && previous.tab === "files"
    yield* store.view.update(VIEW, (row) => {
      const same = row.number === (number ?? null) && row.owner === owner && row.name === name
      row.owner = owner
      row.name = name
      row.repoId = repoId(owner, name)
      row.number = number ?? null
      row.tab = tab
      if (!same) {
        row.pullAbsent = false
        row.pullCheckedAt = 0
        row.merging = false
        row.mergeWriteId = null
        row.mergeRefused = null
        row.reviewing = false
        row.reviewNotice = null
      }
    })
    // Sync status is shared with issues and must follow this route's repository too.
    yield* openIssues(owner, name, number)
    yield* store.route(repoId(owner, name), number)
    // A detail refresh or another merge may move either SHA after the first comparison.
    // Follow the pair while this route shows Files; each immutable pair is still read only once.
    if (number !== undefined && tab === "files" && !alreadyFollowing) {
      const route = store.view.changes({ initial: true }).pipe(Stream.mapEffect(() => store.view.toArray))
      yield* Stream.zipLatest(route, store.routed().pull.rows).pipe(
        Stream.takeWhile(([views]) => {
          const view = views[0]!
          return view.owner === owner && view.name === name && view.number === number && view.tab === "files"
        }),
        Stream.map(([, rows]) => rows.find((row) => row.number === number && SHA.test(row.baseSha) && SHA.test(row.headSha))),
        Stream.filter((row) => row !== undefined),
        Stream.map((row) => ({ baseSha: row.baseSha, headSha: row.headSha })),
        Stream.changesWith((before, after) => before.baseSha === after.baseSha && before.headSha === after.headSha),
        Stream.runForEach((row) => loadFiles(owner, name, row.baseSha, row.headSha)),
        Effect.forkIn(store.scope),
      )
    }
  }).pipe(Effect.orDie)

/** A Files route left. Bound to that page so a late exit cannot close the next pull's Files tab. */
export const closeFiles = (owner: string, name: string, number: number) =>
  Effect.flatMap(PullsStore, (store) => store.view.update(VIEW, (row) => {
    if (row.owner === owner && row.name === name && row.number === number && row.tab === "files") row.tab = "conversation"
  })).pipe(Effect.orDie)

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
      Effect.catch((error) => {
        const refused = error.status === 403 ? "forbidden" : error.status === 401 ? "sign_in" : "unavailable"
        return Metric.update(Metric.withAttributes(mergePresses, { outcome: String(error.status ?? "unreachable") }), 1).pipe(
          Effect.andThen(Effect.logWarning("pulls.merge").pipe(Effect.annotateLogs({
            feature: "pulls",
            outcome: refused,
            errorCode: codeOf(error),
            ...(error.status === undefined ? {} : { status: error.status }),
          }))),
          Effect.andThen(store.view.update(VIEW, (row) => void (row.mergeRefused = refused))),
        )
      }),
      Effect.ensuring(Effect.ignore(store.view.update(VIEW, (row) => void (row.merging = false)))),
      Effect.forkIn(store.scope),
    )
    return true
  }).pipe(Effect.orDie)

/**
 * Review on the routed pull request (decision 0126): `pull/review`, the person's own press, door `button`, bound to the
 * head this page shows. It returns at once; the page says Review requested, or why not (`reviewNoticeOf`), until the
 * route shows another pull request.
 */
export const review = (headSha: string, number: number) =>
  Effect.gen(function* () {
    const store = yield* PullsStore
    const view = (yield* store.view.toArray)[0]!
    if (view.reviewing) return false
    const flows = yield* FlowDispatch
    yield* store.view.update(VIEW, (row) => {
      row.reviewing = true
      row.reviewNotice = null
    })
    yield* flows.dispatch("pull/review", { repo: `${view.owner}/${view.name}`, number, headSha }, { door: "button" }).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        store.view.update(VIEW, (row) => reviewAnswered(row, { owner: view.owner, name: view.name, number }, exit))
      ),
      Effect.orDie,
      Effect.forkIn(store.scope),
    )
    return true
  }).pipe(Effect.orDie)
