import { Host } from "@smthrs/plugin"
import { Effect, Stream } from "effect"

// The queue's tab (decision 0022, slice 1; decision 0017's `needs-you`, renamed): everything that waits on you, one
// item at a time, oldest first or blocking approvals first (`p`). Supports keyboard snoozing (`s`) to defer an item
// for later in the session and restoring snoozed items (`u`). Wherever the cursor rests, it tells the host through
// `select`, so the host's action strip acts on that item. It never answers: answering is `run/answer`, person-only,
// which only the strip sends. Its only wiring is its manifest (../plugin.json) and `PluginHost`.

/** One open wait, as `core/waits` has it. */
export interface Wait {
  readonly runId: string
  readonly version: number
  readonly execution: string
  readonly kind: "question" | "approval"
  readonly prompt: string
  readonly options: ReadonlyArray<string>
  readonly question: boolean
  readonly approval: boolean
  readonly createdAt: string
  /** The repository the wait is about, `github/<owner>/<name>`; empty when it names none. */
  readonly repoId: string
}

/** Queue ordering: FIFO (`oldest`) or blocking approvals ahead of open questions (`approvals`). */
export type SortMode = "oldest" | "approvals"

/** Where the queue stands: the item shown, its place (0 first), how many wait, snoozed count, sort mode, and repo. */
export interface Current {
  readonly item: Wait | undefined
  readonly index: number
  readonly total: number
  readonly snoozed: number
  readonly sort: SortMode
  /** `<owner>/<name>` of the item's repository, when it names one: who asks may be any repository's agent. */
  readonly repository?: string
}

/** A repository's id as a person reads it: `github/acme/widgets` as `acme/widgets`; nothing for none. */
export const repositoryOf = (repoId: string): string | undefined =>
  repoId.startsWith("github/") ? repoId.slice("github/".length) : undefined

/** The queue's view. */
export const VIEW = "queue/queue"

/** Where the cursor moves to: `index` kept inside `total` items, `0` when there are none. */
export const clamp = (index: number, total: number): number => Math.max(0, Math.min(index, total - 1))

/**
 * Where the cursor goes when the waits change: it stays on its item, or, when that one left (answered here or on
 * another device), on the item that took its place.
 */
export const follow = (rows: ReadonlyArray<{ readonly runId: string }>, runId: string | undefined, index: number): number => {
  const at = rows.findIndex((row) => row.runId === runId)
  return at === -1 ? index : at
}

/** Filters out snoozed items (counting only active snoozes) and applies the selected queue ordering. */
export const orderWaits = (
  rows: ReadonlyArray<Wait>,
  snoozedIds: ReadonlySet<string>,
  sort: SortMode,
): { readonly visible: ReadonlyArray<Wait>; readonly snoozed: number } => {
  let snoozed = 0
  const active: Array<Wait> = []
  for (const row of rows) {
    if (snoozedIds.has(row.runId)) snoozed++
    else active.push(row)
  }
  const visible = sort === "approvals"
    ? [...active.filter((row) => row.kind === "approval"), ...active.filter((row) => row.kind !== "approval")]
    : active
  return { visible, snoozed }
}

/** One value, live: what it is now, and a way to hear it changed. */
export interface Watched<A> {
  readonly current: () => A
  readonly subscribe: (listener: () => void) => () => void
}

/** What the queue's components read and do. */
export interface QueueTab {
  readonly queries: { readonly waits: Host.Live<Wait>; readonly current: Watched<Current> }
  readonly actions: {
    readonly open: () => void
    readonly snooze: () => void
    readonly unsnooze: () => void
    readonly toggleSort: () => void
  }
}

/** The tab: built by the host in the plugin's scope on first use. */
export const tab = Effect.gen(function* () {
  const host = yield* Host.PluginHost
  const run = Effect.runForkWith(yield* Effect.context<never>())
  const waits = yield* host.query<Wait>("core/waits")
  const snoozedIds = new Set<string>()
  let sort: SortMode = "oldest"
  let runId: string | undefined
  let current: Current = { item: undefined, index: 0, total: 0, snoozed: 0, sort }
  const listeners = new Set<() => void>()

  /** Puts the cursor at `index` of the visible waits now, tells the host what it selected, and says the queue changed. */
  const settle = (index: number) => {
    const { visible, snoozed } = orderWaits(waits.current(), snoozedIds, sort)
    const at = clamp(index, visible.length)
    const item = visible[at]
    const moved = item?.runId !== runId
    runId = item?.runId
    const repository = item === undefined ? undefined : repositoryOf(item.repoId)
    current = { item, index: at, total: visible.length, snoozed, sort, ...(repository === undefined ? {} : { repository }) }
    if (moved && item !== undefined) run(host.select({ query: "core/waits", key: item.runId }).pipe(Effect.ignore))
    for (const listener of listeners) listener()
  }

  const snooze = () => {
    if (current.item === undefined) return
    snoozedIds.add(current.item.runId)
    settle(current.index)
  }

  const unsnooze = () => {
    if (snoozedIds.size === 0) return
    snoozedIds.clear()
    settle(follow(orderWaits(waits.current(), snoozedIds, sort).visible, runId, current.index))
  }

  const toggleSort = () => {
    sort = sort === "oldest" ? "approvals" : "oldest"
    settle(follow(orderWaits(waits.current(), snoozedIds, sort).visible, runId, 0))
  }

  const stop = waits.subscribe(() => settle(follow(orderWaits(waits.current(), snoozedIds, sort).visible, runId, current.index)))
  yield* Effect.addFinalizer(() => Effect.sync(stop))
  settle(0)

  yield* host.events(VIEW).pipe(
    Stream.runForEach(({ name }) =>
      Effect.sync(() => {
        if (name === "next") settle(current.index + 1)
        else if (name === "previous") settle(current.index - 1)
        else if (name === "snooze") snooze()
        else if (name === "unsnooze") unsnooze()
        else toggleSort()
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )

  return {
    queries: {
      waits,
      current: {
        current: () => current,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => void listeners.delete(listener)
        },
      },
    },
    actions: {
      open: () => void run(host.open(VIEW)),
      snooze,
      unsnooze,
      toggleSort,
    },
  } satisfies QueueTab
})
