import { Effect, FiberHandle, Option, Stream } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import type { ShareAccess } from "../branch/contract"
import type { ShareError } from "./contract"
import { DIALOG, type Change, type Dialog, type ShareRow } from "./schema"
import { SharingStore } from "./store"

// What the owner does in a branch's share dialog (decision 0013 §5, docs/features/branch-workspace.md#sharing): open
// it, add people by login, change or remove what each may do, and set what anyone in the repository with the link may
// do. Every change is the flow `branch/share`; the list the dialog shows is the branch's, synced from Postgres.

const setDialog = (fields: Partial<Omit<Dialog, "id">>) =>
  Effect.flatMap(SharingStore, ({ dialog }) =>
    Effect.orDie(dialog.update(DIALOG, (row) => void Object.assign(row, fields))))

const dialogNow = Effect.flatMap(SharingStore, ({ dialog }) => Effect.map(dialog.get(DIALOG), Option.getOrThrow))

/** Makes the dialog's list `rows`. */
const mirror = (rows: ReadonlyArray<ShareRow>) =>
  Effect.gen(function* () {
    const { list } = yield* SharingStore
    const keep = new Set(rows.map((row) => row.grantee))
    const gone = (yield* list.toArray).filter((row) => !keep.has(row.grantee)).map((row) => row.grantee)
    if (gone.length > 0) yield* Effect.orDie(list.delete(gone))
    for (const row of rows) {
      if (Option.isSome(yield* list.get(row.grantee))) {
        yield* Effect.orDie(list.update(row.grantee, (draft) => void Object.assign(draft, row)))
      } else {
        yield* Effect.orDie(list.insert(row))
      }
    }
  })

/** Opens the share dialog on branch `branchId`, its list kept equal to the branch's while it shows. */
export const openDialog = (branchId: string) =>
  Effect.gen(function* () {
    const store = yield* SharingStore
    store.requests.opening += 1
    store.requests.pending.clear()
    yield* mirror([])
    yield* setDialog({ open: true, branchId, error: null, pending: [] })
    const shares = yield* store.shares(branchId)
    yield* FiberHandle.run(
      store.follower,
      shares.changes({ initial: true }).pipe(
        Stream.runForEach(() => Effect.flatMap(shares.toArray, mirror)),
      ),
    )
  }).pipe(Effect.annotateLogs({ feature: "sharing" }))

/** Closes the share dialog. */
export const closeDialog = Effect.gen(function* () {
  const store = yield* SharingStore
  store.requests.opening += 1
  store.requests.pending.clear()
  yield* FiberHandle.clear(store.follower)
  yield* setDialog({ open: false, pending: [] })
})

/** What a change is in flight under, so the dialog disables that row: the grantee, or the login it shares with. */
const keyOf = (change: Change) => ("login" in change ? change.login.toLowerCase() : change.grantee)

/** Why a change didn't go through, as the dialog says it. */
const errorOf = (reason: string | undefined): ShareError =>
  reason === "no_person" || reason === "too_many" || reason === "forbidden" ? reason : "failed"

/** Applies `change` to the dialog's branch through `branch/share`; a refusal shows in the dialog. */
export const change = (change: Change) =>
  Effect.gen(function* () {
    const store = yield* SharingStore
    const dialog = yield* dialogNow
    if (!dialog.open || dialog.branchId === null) return
    const branchId = dialog.branchId
    const key = keyOf(change)
    const opening = store.requests.opening
    const request = {}
    store.requests.pending.set(key, request)
    yield* setDialog({ error: null, pending: [...new Set([...dialog.pending, key])] })
    const dispatched = yield* Effect.result(
      (yield* FlowDispatch).dispatch("branch/share", { branchId, change }, { door: "button" }),
    )
    yield* Effect.orDie(store.dialog.update(DIALOG, (now) => {
      // Check and apply together: a closed/reopened dialog or a newer change owns its own pending row and error.
      if (!now.open || now.branchId !== branchId || store.requests.opening !== opening ||
        store.requests.pending.get(key) !== request) return
      store.requests.pending.delete(key)
      now.pending = now.pending.filter((pending) => pending !== key)
      if (dispatched._tag === "Success" && dispatched.success._tag === "Done") return
      const error = dispatched._tag === "Success" && dispatched.success._tag === "Failed"
        ? dispatched.success.error
        : undefined
      const reason = error?._tag === "@smthrs/mvp/sharing/BranchShareRefused" ? error.reason : undefined
      now.error = errorOf(reason)
    }))
  }).pipe(Effect.withSpan("branch.share.press"), Effect.annotateLogs({ feature: "sharing" }))

/** Shares the dialog's branch with the person `login`, to `access`. */
export const add = (login: string, access: ShareAccess) => change({ login: login.trim(), access })

/** Changes what `grantee` may do, `null` to remove them. */
export const set = (grantee: string, access: ShareAccess | null) => change({ grantee, access })
