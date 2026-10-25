import { Effect, FiberHandle, Metric, Option, type Result, Stream } from "effect"
import { type DispatchFailed, type Dispatched, FlowDispatch } from "../../flows/dispatch"
import { MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "../issues/contract"
import { readComparison } from "../pulls/comparison"
import { publishes, updates } from "./metrics"
import type { PressRefusal, PublicationRow, PublishPress } from "./publishSchema"
import { PublishStore } from "./publishStore"
import { CURRENT } from "./schema"
import { BranchStore } from "./store"

// What a person does about GitHub on a branch's page (docs/features/branch-publish.md#the-branch-page, rulings GH-6 and
// GH-11): Publish a Smithers-only branch through `branch/publish`, the only way GitHub hears of it, and Update branch
// through `branch/update` once it is published; both door `button`, as the agent and the slash commands run them too.
// Each press is a span, a log line and a count by outcome, never a title or a description. The route shows the branch's
// publication while its page shows it, and its Compare reads the publication's base and head once per pair.

const EMPTY: Omit<PublishPress, "branchId"> = {
  form: false,
  publishing: false,
  publishWriteId: null,
  publishRefused: null,
  updating: false,
  updateWriteId: null,
  updateRefused: null,
}

/** The branch this tab shows, once it is ready. */
const shownBranch = Effect.gen(function* () {
  const row = Option.getOrThrow(yield* (yield* BranchStore).current.get(CURRENT))
  return row.status === "ready" && row.branchId !== null
    ? Option.some({ branchId: row.branchId, owner: row.owner, repo: row.repo, name: row.name })
    : Option.none()
})

const pressOf = (branchId: string) =>
  Effect.flatMap(PublishStore, ({ presses }) => Effect.map(presses.get(branchId), Option.getOrUndefined))

const setPress = (branchId: string, fields: Partial<Omit<PublishPress, "branchId">>) =>
  Effect.gen(function* () {
    const { presses } = yield* PublishStore
    const held = yield* presses.get(branchId)
    yield* Effect.orDie(
      Option.isSome(held)
        ? presses.update(branchId, (row) => void Object.assign(row, fields))
        : presses.insert({ branchId, ...EMPTY, ...fields }),
    )
  })

/** Makes `shown` equal to `rows`, one branch's publication. */
const mirror = (rows: ReadonlyArray<PublicationRow>) =>
  Effect.gen(function* () {
    const { shown } = yield* PublishStore
    const keep = new Set(rows.map((row) => row.branchId))
    const gone = (yield* shown.toArray).filter((row) => !keep.has(row.branchId)).map((row) => row.branchId)
    if (gone.length > 0) yield* Effect.orDie(shown.delete(gone))
    for (const row of rows) {
      yield* Effect.orDie(
        Option.isSome(yield* shown.get(row.branchId))
          ? shown.update(row.branchId, (draft) => void Object.assign(draft, row))
          : shown.insert(row),
      )
    }
  })

/** Reads the publication's base and head into the Compare's comparisons, once per pair. */
const compare = (publication: PublicationRow) =>
  Effect.gen(function* () {
    const store = yield* PublishStore
    const { owner, repo } = Option.getOrThrow(yield* (yield* BranchStore).current.get(CURRENT))
    yield* readComparison(store.comparisons, store.scope, owner, repo, publication.baseSha, publication.headSha)
  })

/**
 * What the branch page's route calls once the branch is open: shows branch `branchId`'s publication, kept equal to
 * Postgres' while the page shows it, and with `compareShown` reads its base and head for the Compare each time they
 * change; `null` shows none. Only the latest page's follower runs.
 */
export const show = (branchId: string | null, compareShown = false) =>
  Effect.gen(function* () {
    const store = yield* PublishStore
    yield* FiberHandle.clear(store.follower)
    // Another branch's publication goes at once; this branch's stays until its shape answers, so nothing flickers.
    yield* mirror((yield* store.shown.toArray).filter((row) => row.branchId === branchId))
    if (branchId === null) return
    const shape = yield* store.publications(branchId)
    yield* FiberHandle.run(
      store.follower,
      shape.changes({ initial: true }).pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const rows = yield* shape.toArray
            yield* mirror(rows)
            if (compareShown) yield* Effect.forEach(rows, compare, { discard: true })
          })
        ),
      ),
    )
  }).pipe(Effect.annotateLogs({ feature: "branch" }))

/** Opens Publish's form on the shown branch. */
export const openForm = Effect.gen(function* () {
  const branch = yield* shownBranch
  if (Option.isSome(branch)) yield* setPress(branch.value.branchId, { form: true })
})

/** Closes Publish's form: Esc. */
export const closeForm = Effect.gen(function* () {
  const branch = yield* shownBranch
  if (Option.isSome(branch)) yield* setPress(branch.value.branchId, { form: false })
})

/** What a press's dispatch answered: the write it started, or why not. */
const settled = (dispatched: Result.Result<Dispatched<"branch/publish">, DispatchFailed>): {
  readonly writeId: string | null
  readonly refused: PressRefusal | null
} => {
  if (dispatched._tag === "Success" && dispatched.success._tag === "Done") {
    return { writeId: dispatched.success.value.writeId, refused: null }
  }
  const error = dispatched._tag === "Success" && dispatched.success._tag === "Failed" ? dispatched.success.error : undefined
  return { writeId: null, refused: error?._tag === "@smthrs/mvp/branch/BranchTrackRefused" ? error.reason : "unavailable" }
}

/** Counts a press by `outcome` and logs it: content-free. */
const record = (counter: typeof publishes, name: "branch.publish.press" | "branch.update.press", outcome: string) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(counter, { outcome }), 1)
    yield* Effect.annotateCurrentSpan({ outcome })
    yield* Effect.logWithLevel(outcome === "sent" ? "Info" : "Warn")(name).pipe(Effect.annotateLogs({ outcome }))
  })

/**
 * Publish on the shown branch: `branch/publish` with the person's title, trimmed, and description. The form closes,
 * and the page says Publishing… until the write settles, or why not. A blank title, a title or description over
 * GitHub's limits, or a Publish this tab is still running, presses nothing. Answers whether it pressed.
 */
export const publish = (title: string, body: string) =>
  Effect.gen(function* () {
    const branch = yield* shownBranch
    if (Option.isNone(branch)) return false
    const { branchId, owner, repo, name } = branch.value
    const trimmed = title.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH || body.length > MAX_BODY_LENGTH) return false
    if ((yield* pressOf(branchId))?.publishing === true) return false
    yield* setPress(branchId, { form: false, publishing: true, publishWriteId: null, publishRefused: null })
    const dispatched = yield* Effect.result(
      (yield* FlowDispatch).dispatch(
        "branch/publish",
        { repo: `${owner}/${repo}`, branch: name, title: trimmed, body },
        { door: "button" },
      ),
    )
    const { writeId, refused } = settled(dispatched)
    yield* setPress(branchId, { publishing: false, publishWriteId: writeId, publishRefused: refused })
    yield* record(publishes, "branch.publish.press", refused ?? "sent")
    return true
  }).pipe(Effect.withSpan("branch.publish.press"), Effect.annotateLogs({ feature: "branch" }))

/**
 * Update branch on the shown branch: `branch/update`. The page says Updating… until the write settles, then how it
 * ended, or why not. An Update this tab is still running presses nothing. Answers whether it pressed.
 */
export const update = Effect.gen(function* () {
  const branch = yield* shownBranch
  if (Option.isNone(branch)) return false
  const { branchId, owner, repo, name } = branch.value
  if ((yield* pressOf(branchId))?.updating === true) return false
  yield* setPress(branchId, { updating: true, updateWriteId: null, updateRefused: null })
  const dispatched = yield* Effect.result(
    (yield* FlowDispatch).dispatch("branch/update", { repo: `${owner}/${repo}`, branch: name }, { door: "button" }),
  )
  const { writeId, refused } = settled(dispatched)
  yield* setPress(branchId, { updating: false, updateWriteId: writeId, updateRefused: refused })
  yield* record(updates, "branch.update.press", refused ?? "sent")
  return true
}).pipe(Effect.withSpan("branch.update.press"), Effect.annotateLogs({ feature: "branch" }))
