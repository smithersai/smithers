import { Data, Effect, Fiber, FiberHandle, Metric, Option, Queue, Ref, Stream } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { share, show } from "../chat/actions"
import { signedOut } from "../auth/store"
import { openAt } from "../conversations/actions"
import { ChatStore } from "../chat/store"
import { isRepository } from "../repo/contract"
import { SharingStore } from "../sharing/store"
import { isBranchName } from "./contract"
import { opens, reopens } from "./metrics"
import { CURRENT, type Current } from "./schema"
import { BranchRoute, BranchStore } from "./store"
import { writes } from "./view"

// What opening a branch's page does (docs/features/branch-workspace.md#the-page): it runs `branch/track` and, once it
// answers, shows the branch's conversation in this tab (decision 0013 §1), so the composer asks there, in the branch's
// prompt when its owner shared it (docs/features/coedit.md#the-prompt). Leaving for `/app` shows the home conversation
// again. Offline, the page doesn't wait for an answer that can't come: it shows what the device has, and the route opens
// the branch again once the browser is back online.

const setCurrent = (fields: Omit<Current, "id">) =>
  Effect.flatMap(BranchStore, ({ current }) =>
    Effect.orDie(current.update(CURRENT, (row) => void Object.assign(row, fields))))

class Superseded extends Data.TaggedError("BranchOpenSuperseded") {}

/**
 * Follows the permission list of the owner's branch `branchId`, shown in this tab, once it has synced: their first share
 * makes its prompt one everyone on it types together, and removing the last makes the draft theirs alone again. Only its
 * owner can read the list, and nobody else can change whether it is shared while they may open it. Opening another
 * branch, or leaving, stops it.
 */
const followShares = (branchId: string) =>
  Effect.gen(function* () {
    const shares = yield* (yield* SharingStore).shares(branchId)
    yield* Effect.ignore(shares.preload)
    yield* shares.changes({ initial: true }).pipe(
      Stream.runForEach(() => Effect.flatMap(shares.toArray, (rows) => share(rows.length > 0))),
    )
  })

/** Why a branch couldn't be shown, from `branch/track`'s failure. */
const statusOf = (reason: string | undefined): Current["status"] =>
  reason === "not_found" || reason === "invalid"
    ? "missing"
    : reason === "sign_in"
    ? "sign_in"
    : reason === "forbidden"
    ? "forbidden"
    : "failed"

/** The shared connection includes transport failures when navigator still reports online after an offline reload. */
const connectionIs = (status: "offline" | "up") =>
  Effect.flatMap(ChatStore, ({ connectionState }) =>
    connectionState.rows.pipe(Stream.filter((rows) => rows.some((row) => row.status === status)), Stream.runHead, Effect.asVoid))

// Subscribe before reading the current flag, so an abort during installation cannot be lost. The stream owns cleanup.
const whenAborted = (signal: AbortSignal) =>
  Stream.callback<boolean>((events) => Effect.acquireRelease(
    Effect.sync(() => {
      const notify = () => { Queue.offerUnsafe(events, signal.aborted) }
      signal.addEventListener("abort", notify)
      notify()
      return notify
    }),
    (notify) => Effect.sync(() => signal.removeEventListener("abort", notify)),
  )).pipe(Stream.filter((aborted) => aborted), Stream.runHead, Effect.asVoid)

/**
 * Opens branch `ref` of `owner/repo` in this tab: `tracking` at once, then `ready` with its conversation shown, or why
 * not. A name that can't be a branch, such as a commit, shows nothing of the workspace. Counted by outcome. Answers
 * the branch's id once it is ready. Nobody signed in, as sign-in's row says, it shows sign in without running
 * `branch/track`, which ChatApi would refuse. The browser offline before `branch/track` answers, it answers none at
 * once and shows `offline`; once the browser is back online, the route opens again (`BranchRoute`), unless `signal`,
 * the navigation's, was aborted: a newer navigation took over, or the page closed.
 */
export const open = (owner: string, repo: string, ref: string, signal?: AbortSignal) =>
  Effect.gen(function* () {
    const { conversations, generation } = yield* BranchStore
    const request = yield* Ref.updateAndGet(generation, (value) => value + 1)
    const stillCurrent = Ref.get(generation).pipe(Effect.flatMap((value) =>
      value === request && signal?.aborted !== true ? Effect.void : Effect.fail(new Superseded())))
    const route = `${owner.toLowerCase()}/${repo.toLowerCase()}/${ref}`
    const empty = { branchId: null, conversationId: null, mode: null, access: null }
    yield* FiberHandle.clear((yield* BranchStore).follower)
    if (!isRepository(owner, repo) || !isBranchName(ref)) {
      yield* setCurrent({ owner, repo, name: ref, status: "missing", ...empty })
      return undefined
    }
    /**
     * Settles the page on why the branch can't be shown: a refusal (not found, sign in, no access) also forgets the
     * conversation the device kept for it.
     */
    const refused = (status: Current["status"]) =>
      Effect.gen(function* () {
        if (status !== "failed") {
          yield* Effect.ignore(conversations.restored)
          yield* stillCurrent
          if (Option.isSome(yield* conversations.get(route))) {
            const removed = yield* conversations.delete(route).pipe(Effect.orDie)
            yield* Effect.ignore(removed.persisted)
          }
        }
        yield* stillCurrent
        yield* setCurrent({ owner, repo, name: ref, status, ...empty })
        yield* Metric.update(Metric.withAttributes(opens, { outcome: status }), 1)
        return undefined
      })
    // Nobody signed in may watch a branch, and ChatApi would answer 401: the page says sign in without asking.
    if (yield* signedOut) return yield* refused("sign_in")
    yield* setCurrent({ owner, repo, name: ref, status: "tracking", ...empty })
    yield* Effect.logInfo("branch.open").pipe(Effect.annotateLogs({ outcome: "tracking" }))
    // The run goes on in the tab's scope whether or not this page still waits: offline, it spends its retries as any
    // run does, and settles.
    const tracking = yield* Effect.forkIn(
      Effect.result(
        (yield* FlowDispatch).dispatch(
          "branch/track",
          // When this open happened, later than anything the device saw for the branch: its step tried again never undoes
          // an archive made since (docs/features/conversations.md#archive).
          { repo: `${owner}/${repo}`, branch: ref, openedAt: yield* openAt(owner, repo, ref) },
          { door: "view" },
        ),
      ),
      (yield* BranchStore).scope,
    )
    const answered = yield* Effect.raceFirst(
      Effect.map(Fiber.join(tracking), Option.some),
      Effect.as(connectionIs("offline"), Option.none()),
    )
    // The tab moved on while the branch was tracked (another branch's page, or home): the answer isn't this page's.
    yield* stillCurrent
    if (Option.isNone(answered)) {
      yield* Effect.ignore(conversations.restored)
      yield* stillCurrent
      const saved = yield* conversations.get(route)
      const conversationId = Option.isSome(saved) ? saved.value.conversationId : null
      if (conversationId !== null) {
        yield* (yield* ChatStore).open(conversationId)
        yield* stillCurrent
        yield* show(conversationId)
        yield* stillCurrent
      }
      yield* setCurrent({ owner, repo, name: ref, status: "offline", ...empty, conversationId })
      yield* Metric.update(Metric.withAttributes(opens, { outcome: "offline" }), 1)
      yield* Effect.logInfo("branch.open").pipe(Effect.annotateLogs({ outcome: "offline" }))
      // Opening another branch, or leaving for home, stops the wait; so does another navigation, or leaving for any
      // other page, which abort `signal`.
      const { follower } = yield* BranchStore
      const { reopen } = yield* BranchRoute
      const reopened = yield* Ref.make(false)
      yield* FiberHandle.run(
        follower,
        Effect.andThen(
          signal === undefined ? connectionIs("up") : Effect.raceFirst(connectionIs("up"), whenAborted(signal)),
          Effect.suspend(() => signal?.aborted === true ? Effect.void : Effect.andThen(
            Ref.set(reopened, true),
            Effect.andThen(Metric.update(Metric.withAttributes(reopens, { outcome: "reopened" }), 1), reopen),
          )),
        ).pipe(Effect.ensuring(Effect.flatMap(Ref.get(reopened), (didReopen) =>
          signal?.aborted === true && !didReopen
            ? Metric.update(Metric.withAttributes(reopens, { outcome: "abandoned" }), 1)
            : Effect.void))),
      )
      return undefined
    }
    const dispatched = answered.value
    if (dispatched._tag === "Success" && dispatched.success._tag === "Done") {
      const tracked = dispatched.success.value
      yield* Effect.ignore(conversations.restored)
      yield* stillCurrent
      const saved = yield* conversations.get(route)
      const write = yield* (Option.isSome(saved)
        ? conversations.update(route, (row) => { row.conversationId = tracked.conversationId })
        : conversations.insert({ id: route, conversationId: tracked.conversationId })).pipe(Effect.orDie)
      yield* Effect.ignore(write.persisted)
      yield* (yield* ChatStore).open(tracked.conversationId)
      yield* stillCurrent
      yield* show(tracked.conversationId, tracked.shared)
      yield* stillCurrent
      if (tracked.access === "owner") {
        const { follower } = yield* BranchStore
        yield* FiberHandle.run(follower, followShares(tracked.branchId))
      }
      yield* setCurrent({
        owner,
        repo,
        name: tracked.name,
        status: "ready",
        branchId: tracked.branchId,
        conversationId: tracked.conversationId,
        mode: tracked.mode,
        access: tracked.access,
      })
      yield* Metric.update(Metric.withAttributes(opens, { outcome: "ready" }), 1)
      return tracked.branchId
    }
    const error = dispatched._tag === "Success" && dispatched.success._tag === "Failed"
      ? dispatched.success.error
      : undefined
    return yield* refused(statusOf(error?._tag === "@smthrs/mvp/branch/BranchTrackRefused" ? error.reason : undefined))
  }).pipe(
    // expected: a newer navigation took the page over
    Effect.catchTag("BranchOpenSuperseded", () => signal?.aborted === true
      ? Metric.update(Metric.withAttributes(reopens, { outcome: "abandoned" }), 1).pipe(Effect.as(undefined))
      : Effect.succeed(undefined)),
    Effect.withSpan("branch.open"),
    Effect.annotateLogs({ feature: "branch" }),
  )


/** Leaves the branch: this tab shows and asks in the home conversation again. */
/**
 * Whether this person may write the branch the page shows now: tracked, as its Owner or with Can edit, and open to
 * changes (not `locked` or `restricted`). Anything missing, such as a branch still tracking, refused or opened offline,
 * is no.
 */
export const writable = Effect.map(
  Effect.flatMap(BranchStore, ({ current }) => current.get(CURRENT)),
  (row) =>
    Option.isSome(row) && row.value.status === "ready" && row.value.access !== null && writes(row.value.access) &&
    row.value.mode === "open",
)

export const leave = Effect.gen(function* () {
  yield* Ref.update((yield* BranchStore).generation, (value) => value + 1)
  yield* FiberHandle.clear((yield* BranchStore).follower)
  yield* setCurrent({
    owner: "",
    repo: "",
    name: "",
    status: "none",
    branchId: null,
    conversationId: null,
    mode: null,
    access: null,
  })
  yield* show(null)
})
